// === FILE: api/midtrans-notification.js ===
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import crypto from 'crypto';

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS || '{}');
if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

export const POST = onRequest(async (req, res) => {
  try {
    const notif = req.body;
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const expectedSig = crypto.createHash('sha512')
      .update(notif.order_id + notif.status_code + notif.gross_amount + serverKey)
      .digest('hex');
    if (notif.signature_key !== expectedSig) return res.status(403).send('Invalid signature');

    const orderId = notif.order_id;
    const snap = await db.collectionGroup('Orders').where('id', '==', orderId).limit(1).get();
    if (snap.empty) return res.status(200).send('Order not found');

    const doc = snap.docs[0];
    const ref = doc.ref;
    const current = doc.data();

    let newStatus = current.status;
    let internalStatus = current.paymentStatusMidtransInternal;
    const ts = notif.transaction_status;
    const fs = notif.fraud_status;

    if (ts === 'capture') {
      newStatus = fs === 'accept' ? 'OrderStatus.processing' : fs === 'challenge' ? 'OrderStatus.pending' : 'OrderStatus.failed';
      internalStatus = fs === 'accept' ? 'paid_captured_accepted' : fs === 'challenge' ? 'payment_challenged_by_fds' : 'failed_fds_check';
    } else if (ts === 'settlement') {
      newStatus = 'OrderStatus.processing';
      internalStatus = 'paid_settled';
    } else if (ts === 'pending') {
      internalStatus = 'pending_payment_completion';
    } else if (ts === 'expire') {
      newStatus = 'OrderStatus.cancelled';
      internalStatus = 'expired_payment';
    } else if (ts === 'cancel') {
      newStatus = 'OrderStatus.cancelled';
      internalStatus = 'cancelled_by_midtrans_or_user';
    } else if (ts === 'deny') {
      newStatus = 'OrderStatus.failed';
      internalStatus = 'denied_by_payment_provider';
    }

    const payload = {
      status: newStatus,
      paymentStatusMidtransInternal: internalStatus,
      midtransTransactionStatus: ts,
      midtransFraudStatus: fs,
      paymentMethod: notif.payment_type,
      midtransNotificationRaw: FieldValue.arrayUnion(notif),
      midtransLastTransactionTime: notif.transaction_time ? Timestamp.fromDate(new Date(notif.transaction_time)) : null,
      updatedAt: FieldValue.serverTimestamp()
    };

    await ref.update(payload);
    res.status(200).send('Notification processed');
  } catch (err) {
    res.status(500).send('Internal server error');
  }
});
