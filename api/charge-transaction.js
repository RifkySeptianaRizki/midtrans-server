// === FILE: api/charge-transaction.js ===
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import midtransClient from 'midtrans-client';
import axios from 'axios';
import crypto from 'crypto';

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS || '{}');
if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

const midtransCoreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

export const POST = onRequest(async (req, res) => {
  const endpointName = '[CHARGE_TRANSACTION]';
  try {
    const {
      orderId, grossAmount, paymentType, itemDetails: itemDetailsForMidtrans,
      customerDetails, userId, fullAddressDetails, itemsFromApp, deliveryDate,
      initialPaymentMethod, productSubtotal, shippingCost, taxAmount,
      appliedPromoCode, discountApplied
    } = req.body;

    const orderRef = db.collection('Users').doc(userId).collection('Orders').doc(orderId);

    const serverCalculatedDiscount = discountApplied || 0;
    const expectedTotal = parseFloat((productSubtotal - serverCalculatedDiscount + shippingCost + taxAmount).toFixed(2));
    const clientGrossAmount = parseFloat(grossAmount.toFixed(2));

    if (Math.abs(expectedTotal - clientGrossAmount) > 0.01) {
      return res.status(400).json({ error: 'Mismatch total.' });
    }

    const orderDataToSave = {
      id: orderId, userId, status: 'OrderStatus.pending', totalAmount: grossAmount,
      productSubtotal, shippingCost, taxAmount, appliedPromoCode: appliedPromoCode || null,
      discountApplied: serverCalculatedDiscount > 0 ? serverCalculatedDiscount : null,
      orderDate: FieldValue.serverTimestamp(),
      paymentMethod: initialPaymentMethod || paymentType,
      address: fullAddressDetails || null,
      deliveryDate: deliveryDate ? Timestamp.fromDate(new Date(deliveryDate)) : null,
      items: itemsFromApp || [],
      paymentStatusMidtransInternal: 'awaiting_midtrans_charge',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await orderRef.set(orderDataToSave, { merge: true });

    const itemDetailsToSend = [...itemDetailsForMidtrans];
    if (typeof discountApplied === 'number' && discountApplied > 0) {
      itemDetailsToSend.push({
        id: `DISC_${appliedPromoCode || 'PROMO'}`,
        price: -Math.round(discountApplied),
        quantity: 1,
        name: `Diskon (${appliedPromoCode || 'Promo'})`
      });
    }

    const sum = itemDetailsToSend.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (Math.round(sum) !== Math.round(grossAmount)) {
      return res.status(400).json({ error: 'Mismatch item detail total vs grossAmount.' });
    }

    const chargeParam = {
      transaction_details: { order_id: orderId, gross_amount: Math.round(grossAmount) },
      item_details: itemDetailsToSend,
      customer_details: customerDetails
    };
    const lcType = paymentType.toLowerCase();
    if (lcType === 'gopay') {
      chargeParam.payment_type = 'gopay';
    } else if (lcType === 'bca_va') {
      chargeParam.payment_type = 'bank_transfer';
      chargeParam.bank_transfer = { bank: 'bca' };
    } else if (lcType === 'permata_va') {
      chargeParam.payment_type = 'bank_transfer';
      chargeParam.bank_transfer = { bank: 'permata' };
    } else {
      return res.status(400).json({ error: `Unsupported payment type '${paymentType}'` });
    }

    const chargeResponse = await midtransCoreApi.charge(chargeParam);

    const updateData = {
      midtransTransactionId: chargeResponse.transaction_id,
      midtransPaymentType: chargeResponse.payment_type,
      midtransTransactionStatus: chargeResponse.transaction_status,
      midtransStatusCode: chargeResponse.status_code,
      midtransStatusMessage: chargeResponse.status_message,
      midtransActions: chargeResponse.actions || null,
      paymentStatusMidtransInternal: 'charge_api_success_pending_user_action',
      updatedAt: FieldValue.serverTimestamp()
    };

    if (chargeResponse.payment_type === 'bank_transfer' && chargeResponse.va_numbers?.length > 0) {
      updateData.virtualAccountNumber = chargeResponse.va_numbers[0].va_number;
      updateData.bank = chargeResponse.va_numbers[0].bank;
    }

    if (chargeResponse.payment_type === 'gopay' && chargeResponse.actions && process.env.FETCH_GOPAY_QR_STRING === 'true') {
      const qrAction = chargeResponse.actions.find(a => a.name === 'generate-qr-code');
      if (qrAction?.url) {
        const basicAuth = 'Basic ' + Buffer.from(process.env.MIDTRANS_SERVER_KEY + ':').toString('base64');
        const resp = await axios.get(qrAction.url, { headers: { Authorization: basicAuth } });
        if (resp.data?.qr_string) {
          updateData.qrisDataString = resp.data.qr_string;
        }
      }
    }

    await orderRef.update(updateData);
    res.status(200).json({ message: 'Transaksi berhasil dibuat', midtransResponse: chargeResponse });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
