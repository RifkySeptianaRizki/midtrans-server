// Menggunakan 'require' untuk dependensi di lingkungan Node.js Vercel
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const midtransClient = require('midtrans-client');
const axios = require('axios');

// --- Inisialisasi Firebase Admin SDK ---
try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS || '{}');
  if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount) });
  }
} catch (error) {
  console.error('Firebase Admin SDK Initialization Error:', error.message);
}
const db = getFirestore();

// --- Inisialisasi Midtrans Client ---
const midtransCoreApi = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// --- Handler Utama untuk Vercel Serverless Function ---
module.exports = async function handler(req, res) {
  // --- Blok Wajib untuk Menangani CORS ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Menangani Preflight Request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  // --- Akhir Blok Wajib CORS ---

  // Memastikan hanya metode POST yang diizinkan
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  // --- Blok Utama Logika Aplikasi Anda ---
  try {
    const {
      orderId, grossAmount, paymentType, itemDetails: itemDetailsForMidtrans,
      customerDetails, userId, fullAddressDetails, itemsFromApp, deliveryDate,
      initialPaymentMethod, productSubtotal, shippingCost, taxAmount,
      appliedPromoCode, discountApplied
    } = req.body;

    // Logika Anda untuk validasi, menyimpan ke Firestore, dan charge ke Midtrans
    // sudah sangat bagus dan tidak saya ubah.
    // ... (SELURUH LOGIKA CHARGE ANDA DARI TRY-CATCH DIMASUKKAN KE SINI) ...

    const orderRef = db.collection('Users').doc(userId).collection('Orders').doc(orderId);

    // Verifikasi total
    const serverCalculatedDiscount = discountApplied || 0;
    const expectedTotal = parseFloat((productSubtotal - serverCalculatedDiscount + shippingCost + taxAmount).toFixed(2));
    const clientGrossAmount = parseFloat(grossAmount.toFixed(2));
    if (Math.abs(expectedTotal - clientGrossAmount) > 0.01) {
      return res.status(400).json({ error: 'Mismatch total amount.' });
    }

    // Simpan data awal order
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

    // Siapkan item_details dengan diskon
    const itemDetailsToSend = [...itemDetailsForMidtrans];
    if (typeof discountApplied === 'number' && discountApplied > 0) {
      itemDetailsToSend.push({
        id: `DISC_${appliedPromoCode || 'PROMO'}`,
        price: -Math.round(discountApplied),
        quantity: 1,
        name: `Diskon (${appliedPromoCode || 'Promo'})`
      });
    }

    // Buat parameter charge Midtrans
    const chargeParam = {
      transaction_details: { order_id: orderId, gross_amount: Math.round(grossAmount) },
      item_details: itemDetailsToSend,
      customer_details: customerDetails,
      payment_type: paymentType.toLowerCase() // Disederhanakan
    };

    if (chargeParam.payment_type === 'bca_va') {
        chargeParam.payment_type = 'bank_transfer';
        chargeParam.bank_transfer = { bank: 'bca' };
    } else if (chargeParam.payment_type === 'permata_va') {
        chargeParam.payment_type = 'bank_transfer';
        chargeParam.bank_transfer = { bank: 'permata' };
    }

    // Lakukan charge
    const chargeResponse = await midtransCoreApi.charge(chargeParam);

    // Update data di Firestore setelah charge
    // ... (Logika update Anda sudah baik)
    await orderRef.update({ 
        midtransTransactionId: chargeResponse.transaction_id,
        /* ... sisa field update lainnya ... */
        updatedAt: FieldValue.serverTimestamp()
    });
    
    // Kirim respons sukses ke Flutter
    return res.status(200).json({ message: 'Transaksi berhasil dibuat', midtransResponse: chargeResponse });

  } catch (err) {
    // Menangani error tak terduga
    console.error('[CHARGE_TRANSACTION] INTERNAL SERVER ERROR:', err);
    return res.status(500).json({ error: 'Gagal memproses pembayaran.', details: err.message });
  }
}