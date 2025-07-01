// === FILE: api/validate-promo.js ===
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS || '{}');
if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

export const POST = onRequest(async (req, res) => {
  const { promoCode, userId, cartSubtotal } = req.body;
  if (!promoCode || typeof promoCode !== 'string') {
    return res.status(400).json({ isValid: false, message: 'Kode promo harus diisi.' });
  }
  if (typeof cartSubtotal !== 'number' || cartSubtotal < 0) {
    return res.status(400).json({ isValid: false, message: 'Subtotal tidak valid.' });
  }

  const code = promoCode.trim().toUpperCase();
  const promoRef = db.collection('promo_codes').doc(code);
  const doc = await promoRef.get();

  if (!doc.exists) return res.status(200).json({ isValid: false, message: 'Kode promo tidak ditemukan.' });

  const promo = doc.data();
  const now = new Date();

  if (!promo.isActive) return res.status(200).json({ isValid: false, message: 'Kode promo tidak aktif.' });
  if (promo.validFrom?.toDate && promo.validFrom.toDate() > now)
    return res.status(200).json({ isValid: false, message: 'Kode promo belum berlaku.' });
  if (promo.validUntil?.toDate && promo.validUntil.toDate() < now)
    return res.status(200).json({ isValid: false, message: 'Kode promo sudah kedaluwarsa.' });

  if (promo.minPurchaseAmount && cartSubtotal < promo.minPurchaseAmount) {
    return res.status(200).json({ isValid: false, message: `Minimal pembelian Rp${promo.minPurchaseAmount}` });
  }

  if (
    typeof promo.totalUsageLimit === 'number' &&
    typeof promo.currentTotalUsage === 'number' &&
    promo.currentTotalUsage >= promo.totalUsageLimit
  ) {
    return res.status(200).json({ isValid: false, message: 'Kuota penggunaan habis.' });
  }

  let discount = 0;
  if (promo.discountType === 'percentage') {
    discount = cartSubtotal * (promo.discountValue / 100);
  } else if (promo.discountType === 'fixed_amount') {
    discount = promo.discountValue;
  }

  discount = Math.min(discount, cartSubtotal);

  return res.status(200).json({
    isValid: true,
    message: promo.description || 'Kode promo berhasil diterapkan!',
    promoDetails: {
      code,
      description: promo.description || 'Diskon diterapkan',
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      calculatedDiscountAmount: parseFloat(discount.toFixed(2)),
    },
  });
});
