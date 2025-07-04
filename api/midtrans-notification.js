// Menggunakan 'require' untuk dependensi di lingkungan Node.js Vercel
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');

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

// --- Handler Utama untuk Vercel Serverless Function ---
export default async function handler(req, res) {
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
    const notificationJson = req.body;
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    
    // Validasi Signature Key (sudah benar)
    const expectedSignatureKey = crypto.createHash('sha512')
      .update(notificationJson.order_id + notificationJson.status_code + notificationJson.gross_amount + serverKey)
      .digest('hex');
      
    if (notificationJson.signature_key !== expectedSignatureKey) {
      return res.status(403).send('Invalid signature');
    }

    // Logika pemrosesan notifikasi Anda (sudah bagus dan tidak diubah)
    const orderId = notificationJson.order_id;
    const ordersSnapshot = await db.collectionGroup('Orders').where('id', '==', orderId).limit(1).get();

    if (ordersSnapshot.empty) {
      return res.status(200).send("Order not found, notification acknowledged.");
    }
    
    const orderDoc = ordersSnapshot.docs[0];
    const orderRef = orderDoc.ref; 
    const currentOrderData = orderDoc.data();

    // Inisialisasi variabel (sudah benar)
let newAppOrderStatus = currentOrderData.status || 'pending';
let newPaymentStatusMidtransInternal = currentOrderData.paymentStatusMidtransInternal || 'awaiting_payment';
const transactionStatus = notificationJson.transaction_status;
const fraudStatus = notificationJson.fraud_status;

// 1. Kondisi 'capture' & 'accept' ditambahkan
if (transactionStatus === 'settlement' || (transactionStatus === 'capture' && fraudStatus === 'accept')) {
    newAppOrderStatus = 'processing';
    // 2. Perbarui juga status internal pembayaran
    newPaymentStatusMidtransInternal = 'paid_settled'; 

} else if (transactionStatus === 'expire' || transactionStatus === 'cancel') {
    newAppOrderStatus = 'cancelled';
    // 2. Perbarui juga status internal pembayaran
    newPaymentStatusMidtransInternal = 'cancelled_or_expired';

} else if (transactionStatus === 'deny') {
    newAppOrderStatus = 'failed';
    // 2. Perbarui juga status internal pembayaran
    newPaymentStatusMidtransInternal = 'denied_by_payment_provider';
}

    // Buat payload update
    const updatePayload = {
      status: newAppOrderStatus,
      paymentStatusMidtransInternal: newPaymentStatusMidtransInternal,
      midtransTransactionStatus: transactionStatus,
      midtransFraudStatus: fraudStatus,
      paymentMethod: notificationJson.payment_type || currentOrderData.paymentMethod,
      midtransNotificationRaw: FieldValue.arrayUnion(notificationJson),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (notificationJson.transaction_time) {
        updatePayload.midtransLastTransactionTime = Timestamp.fromDate(new Date(notificationJson.transaction_time));
    }

    await orderRef.update(updatePayload);
    
    console.log(`[MIDTRANS_NOTIFICATION] Order ${orderId} updated successfully.`);
    return res.status(200).send("Notification processed successfully.");

  } catch (error) {
    // Menangani error tak terduga
    console.error('[MIDTRANS_NOTIFICATION] INTERNAL SERVER ERROR:', error);
    return res.status(500).send('Internal server error while processing notification.');
  }
}