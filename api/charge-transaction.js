const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const midtransClient = require('midtrans-client');

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

    // ✅ PERBAIKAN #1: Tambahkan validasi userId di awal
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
        return res.status(400).json({
            error: "Data Tidak Lengkap",
            details: "Informasi ID pengguna tidak valid. Silakan coba login ulang."
        });
    }

    // Menggunakan 'Users' (huruf besar) sesuai struktur database Anda
    const orderRef = db.collection('Users').doc(userId).collection('Orders').doc(orderId);

    // Verifikasi total (sudah benar)
    const serverCalculatedDiscount = discountApplied || 0;
    const expectedTotal = parseFloat((productSubtotal - serverCalculatedDiscount + shippingCost + taxAmount).toFixed(2));
    const clientGrossAmount = parseFloat(grossAmount.toFixed(2));
    if (Math.abs(expectedTotal - clientGrossAmount) > 0.01) {
      return res.status(400).json({ error: 'Mismatch total amount.' });
    }

    // Simpan data awal order
    const orderDataToSave = {
      id: orderId, userId, 
      status: 'pending',
      totalAmount: grossAmount,
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

    // Siapkan item_details dengan diskon (sudah benar)
    const itemDetailsToSend = [...itemDetailsForMidtrans];
    if (typeof discountApplied === 'number' && discountApplied > 0) {
      itemDetailsToSend.push({
        id: `DISC_${appliedPromoCode || 'PROMO'}`,
        price: -Math.round(discountApplied),
        quantity: 1,
        name: `Diskon (${appliedPromoCode || 'Promo'})`
      });
    }

    // Buat parameter charge Midtrans (sudah benar)
    const chargeParam = {
      transaction_details: { order_id: orderId, gross_amount: Math.round(grossAmount) },
      item_details: itemDetailsToSend,
      customer_details: customerDetails,
      payment_type: paymentType.toLowerCase(),
      custom_field1: userId
    };

    // Logika VA (sudah benar)
    if (chargeParam.payment_type === 'bca_va') {
        chargeParam.payment_type = 'bank_transfer';
        chargeParam.bank_transfer = { bank: 'bca' };
    } else if (chargeParam.payment_type === 'permata_va') {
        chargeParam.payment_type = 'bank_transfer';
        chargeParam.bank_transfer = { bank: 'permata' };
    }

    // ✅ PERBAIKAN #3: Logika Idempotency untuk mencegah error 406
    let chargeResponse;
    try {
        // Cek dulu status transaksi di Midtrans
        chargeResponse = await midtransCoreApi.transaction.status(orderId);
    } catch (e) {
        // Jika errornya 404, berarti transaksi belum ada, maka kita buat charge baru.
        if (e.httpStatusCode === 404) {
            // ✅ PERBAIKAN #4: Panggilan charge HANYA dilakukan di sini
            chargeResponse = await midtransCoreApi.charge(chargeParam);
        } else {
            // Jika error lain, lemparkan agar ditangkap oleh catch utama
            throw e;
        }
    }

    // Update data di Firestore setelah charge (sudah benar)
    await orderRef.update({ 
        midtransTransactionId: chargeResponse.transaction_id,
        paymentStatusMidtransInternal: 'awaiting_payment_confirmation',
        updatedAt: FieldValue.serverTimestamp()
    });
    
    // Kirim respons sukses ke Flutter
    return res.status(200).json({ message: 'Transaksi berhasil dibuat', midtransResponse: chargeResponse });

  } catch (err) {
    // Menangani error tak terduga (sudah benar)
    console.error('[CHARGE_TRANSACTION] INTERNAL SERVER ERROR:', err);
    return res.status(500).json({ error: 'Gagal memproses pembayaran.', details: err.message });
  }
}