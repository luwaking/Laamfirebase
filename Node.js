// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

/**
 * Firestore trigger: when offer.status changes to 'accepted', create an escrow document atomically.
 * Merchant acceptance should update the offer doc (status -> 'accepted'), which triggers this function.
 */
exports.onOfferAccepted = functions.firestore
  .document('offers/{offerId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const offerId = context.params.offerId;

    if(before.status === after.status) return null;
    if(after.status !== 'accepted') return null;

    // create escrow doc inside a transaction to ensure idempotency
    const escrowRef = db.collection('escrows').doc();
    return db.runTransaction(async (tx) => {
      // re-read offer
      const offerSnap = await tx.get(change.after.ref);
      const offer = offerSnap.data();
      if(!offer) throw new Error('Offer not found');

      // ensure we haven't already created escrow
      const existing = await db.collection('escrows').where('offerId','==',offerId).limit(1).get();
      if(!existing.empty) {
        // already created
        await tx.update(change.after.ref, { status: 'in_escrow', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return null;
      }

      const escrow = {
        offerId,
        traderId: offer.traderId,
        buyerId: offer.userId,
        amountUSDT: offer.amountUSDT,
        asset: offer.asset,
        priceETBPerUSDT: offer.priceETBPerUSDT,
        paymentMethod: offer.paymentMethod,
        status: 'in_escrow', // in_escrow -> released -> refunded
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      tx.set(escrowRef, escrow);
      tx.update(change.after.ref, { status: 'in_escrow', escrowId: escrowRef.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

      // Optionally: write notification docs for trader and buyer
      const notRef1 = db.collection('notifications').doc();
      tx.set(notRef1, {
        userId: offer.traderId,
        type: 'offer_accepted',
        offerId,
        message: `You accepted offer ${offerId}. Escrow created.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const notRef2 = db.collection('notifications').doc();
      tx.set(notRef2, {
        userId: offer.userId,
        type: 'offer_accepted',
        offerId,
        message: `Your offer ${offerId} was accepted. Pay the trader via ${offer.paymentMethod}.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return;
    });
  });
