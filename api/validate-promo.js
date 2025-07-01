// Mengimpor library yang dibutuhkan dari firebase-admin
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- Inisialisasi Firebase Admin SDK ---
// Pastikan variabel GOOGLE_APPLICATION_CREDENTIALS sudah diatur di Vercel
try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS || '{}');
  if (getApps().length === 0) {
    initializeApp({
      credential: cert(serviceAccount),
    });
  }
} catch (error) {
  console.error('Firebase Admin SDK Initialization Error:', error.message);
}

// Dapatkan instance Firestore
const db = getFirestore();

// --- Handler Utama untuk Vercel Serverless Function ---
export default async function handler(req, res) {
  // --- Blok Wajib untuk Menangani CORS ---
  // Mengizinkan browser dari domain mana pun untuk mengakses API ini
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Menangani "Preflight Request" (permintaan izin) dari browser
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  // --- Akhir Blok Wajib CORS ---

  // Memastikan hanya metode POST yang diizinkan untuk endpoint ini
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  // --- Blok Utama Logika Aplikasi Anda ---
  // Dibungkus dengan try-catch untuk menangani error tak terduga
  try {
    const { promoCode, userId, cartSubtotal } = req.body;

    // Validasi input dasar
    if (!promoCode || typeof promoCode !== 'string' || promoCode.trim() === '') {
      return res.status(400).json({ isValid: false, message: 'Kode promo harus diisi.' });
    }
    if (typeof cartSubtotal !== 'number' || cartSubtotal < 0) {
      return res.status(400).json({ isValid: false, message: 'Informasi subtotal keranjang tidak valid.' });
    }
    
    // Logika validasi promo Anda (sudah bagus)
    const normalizedPromoCode = promoCode.trim().toUpperCase();
    const promoRef = db.collection('promo_codes').doc(normalizedPromoCode);
    const promoDoc = await promoRef.get();

    if (!promoDoc.exists) {
      return res.status(200).json({ isValid: false, message: 'Kode promo tidak ditemukan.' });
    }

    const promoData = promoDoc.data();
    const now = new Date();

    if (!promoData.isActive) {
      return res.status(200).json({ isValid: false, message: 'Kode promo sudah tidak aktif.' });
    }
    if (promoData.validUntil?.toDate && promoData.validUntil.toDate() < now) {
      return res.status(200).json({ isValid: false, message: 'Kode promo sudah kedaluwarsa.' });
    }
    if (promoData.minPurchaseAmount && cartSubtotal < promoData.minPurchaseAmount) {
      return res.status(200).json({ isValid: false, message: `Minimal pembelian Rp${promoData.minPurchaseAmount} untuk kode ini.` });
    }
    if (
      typeof promoData.totalUsageLimit === 'number' &&
      typeof promoData.currentTotalUsage === 'number' &&
      promoData.currentTotalUsage >= promoData.totalUsageLimit
    ) {
      return res.status(200).json({ isValid: false, message: 'Kuota penggunaan habis.' });
    }

    // Kalkulasi diskon (sudah bagus)
    let calculatedDiscountAmount = 0;
    if (promoData.discountType === 'percentage') {
      calculatedDiscountAmount = cartSubtotal * (promoData.discountValue / 100.0);
    } else if (promoData.discountType === 'fixed_amount') {
      calculatedDiscountAmount = promoData.discountValue;
    }
    
    calculatedDiscountAmount = Math.min(calculatedDiscountAmount, cartSubtotal);

    // Kirim respons sukses
    return res.status(200).json({
      isValid: true,
      message: promoData.description || 'Kode promo berhasil diterapkan!',
      promoDetails: {
        code: normalizedPromoCode,
        description: promoData.description,
        discountType: promoData.discountType,
        discountValue: promoData.discountValue,
        calculatedDiscountAmount: parseFloat(calculatedDiscountAmount.toFixed(2)),
      },
    });

  } catch (error) {
    // Menangani error tak terduga di server
    console.error('[VALIDATE_PROMO] INTERNAL SERVER ERROR:', error);
    return res.status(500).json({ isValid: false, message: 'Terjadi kesalahan internal pada server.' });
  }
}