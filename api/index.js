// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

// ...
const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // Cukup seperti ini saja

app.use(bodyParser.json());

// Inisialisasi Firebase Admin SDK
// GANTI BLOK KODE DI ATAS DENGAN INI
try {
    const serviceAccountString = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountString) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
    }
    
    // Parse string JSON menjadi objek JavaScript
    const serviceAccount = JSON.parse(serviceAccountString);
  
    // Inisialisasi Firebase dengan objek kredensial
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  
  } catch (e) {
    console.error("FATAL ERROR: Firebase Admin SDK Initialization Failed.", e.message);
    process.exit(1); // Hentikan server jika inisialisasi gagal
  }
const db = admin.firestore(); // Instance Firestore Database

// Inisialisasi Midtrans Core API Client
let midtransCoreApi;
try {
    if (!process.env.MIDTRANS_SERVER_KEY || !process.env.MIDTRANS_CLIENT_KEY) {
        throw new Error("Midtrans Server Key or Client Key is missing in .env file. Please check your .env configuration.");
    }
    midtransCoreApi = new midtransClient.CoreApi({
        isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
        serverKey: process.env.MIDTRANS_SERVER_KEY,
        clientKey: process.env.MIDTRANS_CLIENT_KEY
    });
    console.log(`Midtrans CoreApi client initialized successfully (isProduction: ${process.env.MIDTRANS_IS_PRODUCTION === 'true'}).`);
} catch (e) {
    console.error("FATAL ERROR: Midtrans CoreApi Initialization Failed.", e.message, e.stack);
    process.exit(1);
}

// === Middleware untuk Logging Request (Opsional tapi berguna) ===
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    if (Object.keys(req.body).length > 0) {
        console.log("Request Body:", JSON.stringify(req.body, null, 2));
    }
    next();
});


// === ENDPOINT VALIDASI PROMO ===
app.post('/validate-promo', async (req, res) => {
    const endpointName = '[VALIDATE_PROMO]'; // Untuk logging
    try {
        const { promoCode, userId, cartSubtotal } = req.body;
        console.log(`${endpointName} Received - promoCode: "${promoCode}", userId: "${userId}", cartSubtotal: ${cartSubtotal}`);

        if (!promoCode || typeof promoCode !== 'string' || promoCode.trim() === '') {
            console.log(`${endpointName} Validation Error: Kode promo kosong atau bukan string.`);
            return res.status(400).json({ isValid: false, message: 'Kode promo harus diisi.' });
        }
        if (cartSubtotal === undefined || typeof cartSubtotal !== 'number' || cartSubtotal < 0) {
            console.log(`${endpointName} Validation Error: cartSubtotal tidak valid atau negatif.`);
            return res.status(400).json({ isValid: false, message: 'Informasi subtotal keranjang tidak valid.' });
        }
        // Validasi userId bisa ditambahkan jika promo tergantung user tertentu

        const normalizedPromoCode = promoCode.trim().toUpperCase();
        console.log(`${endpointName} Normalized promoCode: "${normalizedPromoCode}"`);
        const promoRef = db.collection('promo_codes').doc(normalizedPromoCode);
        const promoDoc = await promoRef.get();

        if (!promoDoc.exists) {
            console.log(`${endpointName} Promo code "${normalizedPromoCode}" not found.`);
            return res.status(200).json({ isValid: false, message: 'Kode promo tidak ditemukan.' });
        }

        const promoData = promoDoc.data();
        console.log(`${endpointName} Promo data from Firestore for "${normalizedPromoCode}":`, JSON.stringify(promoData, null, 2));

        // Validasi field penting dari promoData
        if (typeof promoData.isActive !== 'boolean') {
             console.error(`${endpointName} Data Error: Field "isActive" is missing or not a boolean for code: ${normalizedPromoCode}`);
             throw new Error('Data promo error di database: properti isActive tidak valid.');
        }
        if (!promoData.isActive) {
            console.log(`${endpointName} Promo code "${normalizedPromoCode}" is not active.`);
            return res.status(200).json({ isValid: false, message: 'Kode promo sudah tidak aktif.' });
        }

        const now = new Date();
        if (promoData.validFrom && promoData.validFrom.toDate && typeof promoData.validFrom.toDate === 'function') {
            if (promoData.validFrom.toDate() > now) {
                console.log(`${endpointName} Promo code "${normalizedPromoCode}" is not yet valid.`);
                return res.status(200).json({ isValid: false, message: 'Kode promo belum berlaku.' });
            }
        }
        if (promoData.validUntil && promoData.validUntil.toDate && typeof promoData.validUntil.toDate === 'function') {
            if (promoData.validUntil.toDate() < now) {
                console.log(`${endpointName} Promo code "${normalizedPromoCode}" has expired.`);
                return res.status(200).json({ isValid: false, message: 'Kode promo sudah kedaluwarsa.' });
            }
        }

        if (promoData.minPurchaseAmount != null && typeof promoData.minPurchaseAmount === 'number' && cartSubtotal < promoData.minPurchaseAmount) {
            console.log(`${endpointName} Cart subtotal ${cartSubtotal} < min purchase ${promoData.minPurchaseAmount} for "${normalizedPromoCode}".`);
            return res.status(200).json({ isValid: false, message: `Minimal pembelian Rp${promoData.minPurchaseAmount} untuk kode ini.` });
        }
        
        if (promoData.totalUsageLimit != null && promoData.currentTotalUsage != null && 
            typeof promoData.totalUsageLimit === 'number' && typeof promoData.currentTotalUsage === 'number' &&
            promoData.currentTotalUsage >= promoData.totalUsageLimit) {
            console.log(`${endpointName} Promo code "${normalizedPromoCode}" usage limit reached.`);
            return res.status(200).json({ isValid: false, message: 'Kuota penggunaan kode promo sudah habis.' });
        }
        
        // TODO: Implementasi validasi usageLimitPerUser (memerlukan tracking penggunaan promo per user)

        let calculatedDiscountAmount = 0;
        if (typeof promoData.discountType !== 'string' || typeof promoData.discountValue !== 'number') {
            console.error(`${endpointName} Data Error: Invalid discountType or discountValue for promo: ${normalizedPromoCode}`);
            throw new Error('Data promo error di database: properti diskon tidak valid.');
        }

        if (promoData.discountType === 'percentage') {
            calculatedDiscountAmount = cartSubtotal * (promoData.discountValue / 100.0);
        } else if (promoData.discountType === 'fixed_amount') {
            calculatedDiscountAmount = promoData.discountValue;
        } else {
            console.warn(`${endpointName} Unknown discountType: ${promoData.discountType} for promo: ${normalizedPromoCode}`);
            return res.status(200).json({ isValid: false, message: 'Jenis diskon pada promo tidak dikenal.' });
        }
        
        calculatedDiscountAmount = Math.min(calculatedDiscountAmount, cartSubtotal); // Diskon tidak boleh melebihi subtotal


        console.log(`${endpointName} Promo "${normalizedPromoCode}" applied successfully. Discount: ${calculatedDiscountAmount}`);
        res.status(200).json({
            isValid: true,
            message: promoData.description || 'Kode promo berhasil diterapkan!',
            promoDetails: {
                code: promoData.code || normalizedPromoCode,
                description: promoData.description || 'Diskon diterapkan',
                discountType: promoData.discountType,
                discountValue: promoData.discountValue,
                calculatedDiscountAmount: parseFloat(calculatedDiscountAmount.toFixed(2))
            }
        });

    } catch (error) {
        console.error(`${endpointName} INTERNAL SERVER ERROR:`, error.message, error.stack);
        res.status(500).json({ isValid: false, message: 'Terjadi kesalahan pada server. Silakan coba lagi nanti.', error_details_server: error.message });
    }
});


// === ENDPOINT CHARGE TRANSACTION ===
app.post('/charge-transaction', async (req, res) => {
    const endpointName = '[CHARGE_TRANSACTION]';
    try {
        const {
            orderId, grossAmount, paymentType, itemDetails: itemDetailsForMidtrans,
            customerDetails, userId, fullAddressDetails, itemsFromApp, deliveryDate,
            initialPaymentMethod, productSubtotal, shippingCost, taxAmount,
            appliedPromoCode, discountApplied
        } = req.body;

        console.log(`${endpointName} Received - orderId: ${orderId}, userId: ${userId}, grossAmount: ${grossAmount}, promo: ${appliedPromoCode}, discount: ${discountApplied}`);

        // Validasi Input Dasar (Sudah Cukup Baik)
        if (!userId || !orderId || typeof grossAmount !== 'number' || grossAmount <= 0 || !paymentType || !itemDetailsForMidtrans || !customerDetails || !itemsFromApp) {
            console.error(`${endpointName} Validation Error: Incomplete transaction data.`, req.body);
            return res.status(400).json({ error: 'Data transaksi tidak lengkap atau format salah.', details: "Pastikan semua field wajib terisi." });
        }
        // ... (validasi lain untuk productSubtotal, shippingCost, taxAmount, appliedPromoCode, discountApplied sudah ada dan baik) ...
         if (typeof productSubtotal !== 'number' || productSubtotal < 0) {
             console.error(`${endpointName} Validation Error: productSubtotal tidak valid:`, req.body.productSubtotal);
             return res.status(400).json({ error: 'Subtotal produk tidak valid.'});
        }
        if (typeof shippingCost !== 'number' || shippingCost < 0) {
             console.error(`${endpointName} Validation Error: shippingCost tidak valid:`, req.body.shippingCost);
             return res.status(400).json({ error: 'Biaya pengiriman tidak valid.'});
        }
        if (typeof taxAmount !== 'number' || taxAmount < 0) {
             console.error(`${endpointName} Validation Error: taxAmount tidak valid:`, req.body.taxAmount);
             return res.status(400).json({ error: 'Biaya pajak tidak valid.'});
        }
        if (appliedPromoCode && typeof appliedPromoCode !== 'string') {
             console.error(`${endpointName} Validation Error: appliedPromoCode tidak valid:`, req.body.appliedPromoCode);
             return res.status(400).json({ error: 'Kode promo yang diterapkan tidak valid.'});
        }
        if (discountApplied !== undefined && discountApplied !== null && (typeof discountApplied !== 'number' || discountApplied < 0)) {
             console.error(`${endpointName} Validation Error: discountApplied tidak valid:`, req.body.discountApplied);
             return res.status(400).json({ error: 'Jumlah diskon yang diterapkan tidak valid.'});
        }


        const orderRef = db.collection('Users').doc(userId).collection('Orders').doc(orderId);

        // Verifikasi total (PENTING)
        const serverCalculatedDiscount = discountApplied || 0;
        const expectedTotal = parseFloat((productSubtotal - serverCalculatedDiscount + shippingCost + taxAmount).toFixed(2));
        const clientGrossAmount = parseFloat(grossAmount.toFixed(2));

        if (Math.abs(expectedTotal - clientGrossAmount) > 0.01) { // Toleransi float
            console.error(`${endpointName} FATAL MISMATCH for order ${orderId}: Server total (${expectedTotal}) vs Client grossAmount (${clientGrossAmount}).`);
            console.error(`Details - Subtotal: ${productSubtotal}, Discount: ${serverCalculatedDiscount}, Shipping: ${shippingCost}, Tax: ${taxAmount}`);
            return res.status(400).json({ error: 'Terjadi ketidaksesuaian perhitungan total akhir. Mohon refresh dan coba lagi.'});
        }

        // Data untuk disimpan ke Firestore (Sudah Baik)
        const orderDataToSave = {
            id: orderId, userId, status: 'OrderStatus.pending', totalAmount: grossAmount,
            productSubtotal, shippingCost, taxAmount, appliedPromoCode: appliedPromoCode || null,
            discountApplied: serverCalculatedDiscount > 0 ? serverCalculatedDiscount : null, // Simpan diskon jika > 0
            orderDate: admin.firestore.FieldValue.serverTimestamp(),
            paymentMethod: initialPaymentMethod || paymentType, address: fullAddressDetails || null,
            deliveryDate: deliveryDate ? admin.firestore.Timestamp.fromDate(new Date(deliveryDate)) : null,
            items: itemsFromApp || [], midtransTransactionId: null, midtransPaymentType: null,
            midtransTransactionStatus: null, midtransActions: null, midtransStatusCode: null,
            midtransStatusMessage: null, qrisDataString: null,
            paymentStatusMidtransInternal: 'awaiting_midtrans_charge',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await orderRef.set(orderDataToSave, { merge: true });
        console.log(`${endpointName} Order ${orderId} initial data saved/updated.`);

        // Persiapan parameter untuk Midtrans
        let itemDetailsToSendToMidtrans = [...itemDetailsForMidtrans]; // itemDetailsForMidtrans adalah yang dari Flutter (produk, ongkir, pajak)

        if (typeof discountApplied === 'number' && discountApplied > 0) {
            itemDetailsToSendToMidtrans.push({
                id: `DISC_${appliedPromoCode || 'PROMO'}`, // ID unik untuk item diskon
                price: -Math.round(discountApplied),      // <<< HARGA NEGATIF untuk diskon
                quantity: 1,
                name: `Diskon (${appliedPromoCode || 'Promo'})`
            });
            console.log(`${endpointName} Added discount item to Midtrans item_details: ${-Math.round(discountApplied)}`);
        }
        
        // Verifikasi sekarang: Jumlah dari itemDetailsToSendToMidtrans seharusnya sama dengan grossAmount
        let sumForMidtransVerification = 0;
        itemDetailsToSendToMidtrans.forEach(item => {
            sumForMidtransVerification += item.price * item.quantity;
        });
        // Pembulatan di kedua sisi untuk perbandingan yang lebih aman
        const roundedSumForMidtrans = Math.round(sumForMidtransVerification);
        const roundedGrossAmount = Math.round(grossAmount);

        console.log(`${endpointName} Sum of itemDetails for Midtrans (after discount item): ${roundedSumForMidtrans}, GrossAmount for Midtrans: ${roundedGrossAmount}`);
        
        if (roundedSumForMidtrans !== roundedGrossAmount) {
            console.error(`${endpointName} MISMATCH for order ${orderId}: Sum of item_details for Midtrans (${roundedSumForMidtrans}) still does not match grossAmount (${roundedGrossAmount}). This is critical for Midtrans.`);
            // Anda HARUS mengembalikan error di sini karena Midtrans akan menolaknya.
            return res.status(400).json({ 
                error: 'Terjadi ketidaksesuaian internal pada rincian biaya untuk Midtrans.',
                details: `Server sum: ${roundedSumForMidtrans}, Client gross: ${roundedGrossAmount}`
            });
        }

        let chargeParameter = {
            transaction_details: { 
                order_id: orderId, 
                gross_amount: Math.round(grossAmount) // Pastikan gross_amount adalah integer (jika Midtrans mengharapkannya)
            },
            item_details: itemDetailsToSendToMidtrans, // Gunakan yang sudah ada item diskonnya
            customer_details: customerDetails,
        };
        // ... (logika paymentType Anda sudah baik) ...
         const lcPaymentType = paymentType.toLowerCase();
        if (lcPaymentType === 'gopay') {
            chargeParameter.payment_type = "gopay";
        } else if (lcPaymentType === 'bca_va') {
            chargeParameter.payment_type = "bank_transfer";
            chargeParameter.bank_transfer = { bank: "bca" };
        } else if (lcPaymentType === 'permata_va') {
            chargeParameter.payment_type = "bank_transfer";
            chargeParameter.bank_transfer = { bank: "permata" };
        } else {
            console.error(`${endpointName} Unsupported payment type: ${paymentType} for order ${orderId}`);
            await orderRef.update({ status: 'OrderStatus.failed', errorDetails: `Metode pembayaran '${paymentType}' tidak didukung.`, paymentStatusMidtransInternal: 'backend_payment_type_unsupported', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            return res.status(400).json({ error: `Metode pembayaran '${paymentType}' tidak didukung.` });
        }

        console.log(`${endpointName} Charging Midtrans for order ${orderId} with type ${chargeParameter.payment_type}, grossAmount ${grossAmount}`);
        const chargeResponse = await midtransCoreApi.charge(chargeParameter); // Menggunakan midtransCoreApi
        console.log(`${endpointName} Midtrans charge SUCCESS for order ${orderId}. Status: ${chargeResponse.transaction_status}`);

        // Update Firestore setelah charge (Sudah Baik)
        let finalMidtransResponseForFlutter = { ...chargeResponse };
        let updateForFirestoreAfterCharge = { /* ... */ }; // Seperti kode Anda
        // ... (logika Anda untuk mengisi updateForFirestoreAfterCharge dan finalMidtransResponseForFlutter) ...
         updateForFirestoreAfterCharge = {
            midtransTransactionId: chargeResponse.transaction_id,
            midtransPaymentType: chargeResponse.payment_type, 
            midtransTransactionStatus: chargeResponse.transaction_status,
            midtransStatusCode: chargeResponse.status_code,
            midtransStatusMessage: chargeResponse.status_message,
            midtransActions: chargeResponse.actions || null,
            paymentStatusMidtransInternal: 'charge_api_success_pending_user_action',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
         if (chargeResponse.payment_type === 'gopay' && chargeResponse.actions) {
            const qrCodeAction = chargeResponse.actions.find(action => action.name === 'generate-qr-code');
            // Logika fetch QR string tetap opsional dengan flag environment
            if (qrCodeAction && qrCodeAction.url && process.env.FETCH_GOPAY_QR_STRING === 'true') {
                 try {
                    const midtransApiUsername = process.env.MIDTRANS_SERVER_KEY;
                    const basicAuth = 'Basic ' + Buffer.from(midtransApiUsername + ':').toString('base64');
                    const qrApiResponse = await axios.get(qrCodeAction.url, {
                        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': basicAuth }
                    });
                    if (qrApiResponse.data && qrApiResponse.data.qr_string) {
                        updateForFirestoreAfterCharge.qrisDataString = qrApiResponse.data.qr_string;
                        finalMidtransResponseForFlutter.qris_data_string = qrApiResponse.data.qr_string;
                        console.log(`${endpointName} Successfully fetched GoPay QRIS string for order ${orderId}.`);
                    } else {
                         console.warn(`${endpointName} GoPay QR string not found in API response for order ${orderId}. URL: ${qrCodeAction.url}`);
                    }
                } catch (qrError) { 
                    console.error(`${endpointName} Error fetching GoPay QRIS string for order ${orderId}:`, qrError.response ? qrError.response.data : qrError.message); 
                }
            }
        }
        if (chargeResponse.payment_type === 'bank_transfer' && chargeResponse.va_numbers && chargeResponse.va_numbers.length > 0) {
            updateForFirestoreAfterCharge.virtualAccountNumber = chargeResponse.va_numbers[0].va_number;
            updateForFirestoreAfterCharge.bank = chargeResponse.va_numbers[0].bank; 
            finalMidtransResponseForFlutter.va_numbers = chargeResponse.va_numbers; 
        }


        await orderRef.update(updateForFirestoreAfterCharge);
        console.log(`${endpointName} Order ${orderId} updated with Midtrans charge details.`);

        res.status(200).json({
            message: "Transaksi berhasil dibuat dengan Midtrans.",
            orderId: orderId,
            paymentType: chargeResponse.payment_type,
            midtransResponse: finalMidtransResponseForFlutter
        });

    } catch (error) { // Error handling utama (Sudah Baik)
        // ... (kode error handling Anda) ...
        const orderIdFromBody = req.body.orderId;
        const userIdFromBody = req.body.userId;
        const errorMessage = error.ApiResponse ? JSON.stringify(error.ApiResponse.data, null, 2) : error.message;
        console.error(`${endpointName} Error for orderId '${orderIdFromBody || 'N/A'}':`, errorMessage, error.stack);

        if (orderIdFromBody && userIdFromBody) {
            try {
                const orderRefForError = db.collection('Users').doc(userIdFromBody).collection('Orders').doc(orderIdFromBody);
                await orderRefForError.update({
                    status: 'OrderStatus.failed',
                    errorDetails: `Charge API Error: ${error.message.substring(0, 500)}`,
                    paymentStatusMidtransInternal: 'charge_api_failed',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            } catch (dbError) {
                console.error(`${endpointName} DB Error after charge error for order ${orderIdFromBody}:`, dbError);
            }
        }
        res.status(error.httpStatusCode || 500).json({
            error: 'Gagal memproses pembayaran dengan Midtrans.',
            details: error.ApiResponse ? error.ApiResponse.data : error.message
        });
    }
});

// === ENDPOINT NOTIFIKASI MIDTRANS (SUDAH CUKUP BAIK DARI SEBELUMNYA) ===
app.post('/midtrans-notification', async (req, res) => {
    // ... (Kode notifikasi Anda yang sudah ada, pastikan konsisten dengan perubahan status OrderModel) ...
    const endpointName = '[MIDTRANS_NOTIFICATION]';
    console.log(`${endpointName} Received raw body:`, JSON.stringify(req.body));
    try {
        const notificationJson = req.body;
        const serverKey = process.env.MIDTRANS_SERVER_KEY;
        // ... (validasi signature key Anda sudah baik) ...
        if (!serverKey) {
            console.error(`${endpointName} MIDTRANS_SERVER_KEY is not set.`);
            return res.status(500).send("Server configuration error.");
        }
        const receivedSignatureKey = notificationJson.signature_key;
        const stringToHash = notificationJson.order_id + notificationJson.status_code + notificationJson.gross_amount + serverKey;
        const calculatedSignatureKey = crypto.createHash('sha512').update(stringToHash).digest('hex');

        if (calculatedSignatureKey !== receivedSignatureKey) {
            console.warn(`${endpointName} Invalid signature key for orderId: ${notificationJson.order_id}.`);
            return res.status(403).send("Invalid signature.");
        }
        console.log(`${endpointName} Signature VERIFIED for orderId: ${notificationJson.order_id}`);


        const orderId = notificationJson.order_id;
        const transactionStatus = notificationJson.transaction_status;
        const fraudStatus = notificationJson.fraud_status;
        const paymentTypeFromNotif = notificationJson.payment_type;
        const transactionTime = notificationJson.transaction_time; 

        console.log(`${endpointName} Processing - OrderID: ${orderId}, TS: ${transactionStatus}, FS: ${fraudStatus}, PT: ${paymentTypeFromNotif}.`);

        const ordersSnapshot = await db.collectionGroup('Orders').where('id', '==', orderId).limit(1).get();

        if (ordersSnapshot.empty) {
            console.warn(`${endpointName} Order ${orderId} not found.`);
            return res.status(200).send("Order not found, notification acknowledged.");
        }
        
        const orderDoc = ordersSnapshot.docs[0];
        const orderRef = orderDoc.ref; 
        const currentOrderData = orderDoc.data();

        let newAppOrderStatus = currentOrderData.status; 
        let newPaymentStatusMidtransInternal = currentOrderData.paymentStatusMidtransInternal;
        
        // Logika pemetaan status (sudah cukup baik, pastikan string OrderStatus konsisten dengan Enum di Flutter)
        if (transactionStatus === 'capture') { 
            if (fraudStatus === 'accept') { newAppOrderStatus = 'OrderStatus.processing'; newPaymentStatusMidtransInternal = 'paid_captured_accepted'; } 
            else if (fraudStatus === 'challenge') { newAppOrderStatus = 'OrderStatus.pending'; newPaymentStatusMidtransInternal = 'payment_challenged_by_fds'; } 
            else { newAppOrderStatus = 'OrderStatus.failed'; newPaymentStatusMidtransInternal = 'failed_fds_check';}
        } else if (transactionStatus === 'settlement') { 
            newAppOrderStatus = 'OrderStatus.processing'; newPaymentStatusMidtransInternal = 'paid_settled';
        } else if (transactionStatus === 'pending') {
            newAppOrderStatus = currentOrderData.status === 'OrderStatus.failed' ? 'OrderStatus.pending' : currentOrderData.status; // Jangan ubah jika sudah diproses/dibayar
            newPaymentStatusMidtransInternal = 'pending_payment_completion';
        } else if (transactionStatus === 'expire') {
            if (!['OrderStatus.processing', 'OrderStatus.paid', 'OrderStatus.delivered', 'OrderStatus.shipped'].includes(currentOrderData.status) ) { newAppOrderStatus = 'OrderStatus.cancelled'; }
            newPaymentStatusMidtransInternal = 'expired_payment';
        } else if (transactionStatus === 'cancel') {
             if (!['OrderStatus.processing', 'OrderStatus.paid', 'OrderStatus.delivered', 'OrderStatus.shipped'].includes(currentOrderData.status) ) { newAppOrderStatus = 'OrderStatus.cancelled'; }
            newPaymentStatusMidtransInternal = 'cancelled_by_midtrans_or_user';
        } else if (transactionStatus === 'deny') {
            newAppOrderStatus = 'OrderStatus.failed'; newPaymentStatusMidtransInternal = 'denied_by_payment_provider';
        }

        const updatePayload = {
            status: newAppOrderStatus, paymentStatusMidtransInternal: newPaymentStatusMidtransInternal,
            midtransTransactionStatus: transactionStatus, midtransFraudStatus: fraudStatus, 
            paymentMethod: paymentTypeFromNotif || currentOrderData.paymentMethod, 
            midtransNotificationRaw: admin.firestore.FieldValue.arrayUnion(notificationJson), 
            ...(transactionTime && { midtransLastTransactionTime: admin.firestore.Timestamp.fromDate(new Date(transactionTime)) }), 
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await orderRef.update(updatePayload);
        console.log(`${endpointName} Order ${orderId} updated. New App Status: ${newAppOrderStatus}, Midtrans TS: ${transactionStatus}`);
        res.status(200).send("Notification processed successfully.");
    } catch (error) {
        console.error(`${endpointName} Error processing notification:`, error.message, error.stack);
        res.status(200).send("Notification received, but internal server error occurred.");
    }
});

/// Tambahkan ini di baris paling akhir file
module.exports = app;