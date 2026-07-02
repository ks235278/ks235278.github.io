"use strict";
/**
 * Tango — Cloud Functions: nơi DUY NHẤT được ghi xu.
 * Vùng tin cậy: đề thi sinh ở đây, đáp án ở lại đây, chấm trong transaction,
 * sổ cái append-only, admin chỉnh xu qua callable riêng có bút toán.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const BANK = require("./bank.json");

setGlobalOptions({ region: "asia-northeast1", maxInstances: 10 });
admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const ADMIN_EMAIL = "ks235278@kaichi.ac.jp";
const DEFAULTS = {
  cycleDays: 30,          // độ dài chu kỳ thưởng
  cycleFee: 1000,         // phí mở chu kỳ (xu ảo)
  rewardCapRatio: 0.2,    // trần thang thưởng = 20% phí
  targetItems: 100,       // mục tiêu mục "đã thuộc" / chu kỳ (định đơn giá)
  testSize: 20,           // số câu tối đa / bài thi chính thức
  dailyLimit: 1,          // số bài thi chính thức / ngày (JST)
  eligibilityMinutes: 3 * 24 * 60, // mục "chín" sau 3 ngày (dev: admin đặt = 3 phút)
  perQuestionSec: 8,
  graceSec: 15,
};
const ITEMS = new Map(BANK.items.map((it) => [it.id, it]));

/* ── Helpers ─────────────────────────────────────────────────────────── */
async function getCfg() {
  const s = await db.doc("tango_config/app").get();
  const c = { ...DEFAULTS, ...(s.exists ? s.data() : {}) };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(c[k]);
    c[k] = Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
  }
  return c;
}
function reqAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Cần đăng nhập.");
  return req.auth;
}
function reqAdmin(req) {
  const a = reqAuth(req);
  if (a.token.email !== ADMIN_EMAIL && a.token.admin !== true)
    throw new HttpsError("permission-denied", "Chỉ admin mới được thao tác này.");
  return a;
}
const jstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Ghi 1 bút toán + cập nhật ví trong transaction. wSnap PHẢI đọc trước bằng tx.get. */
function ledgerWrite(tx, uid, wSnap, entry) {
  const wRef = db.doc(`tango_wallets/${uid}`);
  const cur = wSnap.exists ? wSnap.data() : { balance: 0, seq: 0 };
  const balance = (cur.balance || 0) + entry.amount;
  if (balance < 0) throw new HttpsError("failed-precondition", `Không đủ xu (đang có ${cur.balance || 0}).`);
  const seq = (cur.seq || 0) + 1;
  tx.set(wRef, { balance, seq, updatedAt: FieldValue.serverTimestamp(),
                 ...(entry.email ? { email: entry.email } : {}) }, { merge: true });
  tx.set(wRef.collection("ledger").doc(), {
    seq, type: entry.type, amount: entry.amount, balanceAfter: balance,
    reason: entry.reason || null, refId: entry.refId || null,
    createdBy: entry.createdBy || "system", createdAt: FieldValue.serverTimestamp(),
  });
  return { balance, seq };
}
async function getActiveCycle(tx, uid) {
  const q = db.collection("tango_cycles")
    .where("uid", "==", uid).where("status", "==", "active").limit(1);
  const s = await tx.get(q);
  return s.empty ? null : { ref: s.docs[0].ref, ...s.docs[0].data() };
}

/* ── openCycle: trừ phí, mở chu kỳ 30 ngày ──────────────────────────── */
exports.openCycle = onCall(async (req) => {
  const auth = reqAuth(req);
  const cfg = await getCfg();
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const cyc = await getActiveCycle(tx, auth.uid);
    if (cyc) {
      if (cyc.endAt.toMillis() <= now)
        throw new HttpsError("failed-precondition", "Chu kỳ trước đã hết hạn — hãy Chốt chu kỳ trước khi mở mới.");
      throw new HttpsError("failed-precondition", "Bạn đang có chu kỳ chạy rồi.");
    }
    const wSnap = await tx.get(db.doc(`tango_wallets/${auth.uid}`));
    const cap = Math.round(cfg.cycleFee * cfg.rewardCapRatio);
    const unitPlus = Math.max(1, Math.ceil(cap / cfg.targetItems));
    const unitMinus = Math.max(1, Math.floor(unitPlus / 2));
    const cycRef = db.collection("tango_cycles").doc();
    ledgerWrite(tx, auth.uid, wSnap, {
      type: "cycle_fee", amount: -cfg.cycleFee, refId: cycRef.id,
      reason: `mở chu kỳ ${cfg.cycleDays} ngày`, email: auth.token.email || null,
    });
    tx.set(cycRef, {
      uid: auth.uid, status: "active",
      startAt: Timestamp.fromMillis(now),
      endAt: Timestamp.fromMillis(now + cfg.cycleDays * 86400e3),
      fee: cfg.cycleFee, cap, targetItems: cfg.targetItems, unitPlus, unitMinus,
      rewardMeter: 0, testsTaken: 0, lastTestDay: null, lastTestCount: 0,
      servedIds: [], createdAt: FieldValue.serverTimestamp(),
    });
    return { cycleId: cycRef.id, cap, unitPlus, unitMinus };
  });
});

/* ── settleCycle: hết hạn → cộng thang thưởng vào ví ────────────────── */
exports.settleCycle = onCall(async (req) => {
  const auth = reqAuth(req);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const cyc = await getActiveCycle(tx, auth.uid);
    if (!cyc) throw new HttpsError("failed-precondition", "Không có chu kỳ nào đang chạy.");
    if (cyc.endAt.toMillis() > now)
      throw new HttpsError("failed-precondition", `Chu kỳ chưa hết hạn (còn đến ${new Date(cyc.endAt.toMillis()).toLocaleDateString("vi-VN")}).`);
    const wSnap = await tx.get(db.doc(`tango_wallets/${auth.uid}`));
    const reward = cyc.rewardMeter || 0;
    if (reward > 0)
      ledgerWrite(tx, auth.uid, wSnap, {
        type: "cycle_settle", amount: reward, refId: cyc.ref.id,
        reason: "chốt thưởng chu kỳ", email: auth.token.email || null,
      });
    tx.update(cyc.ref, { status: "settled", settledAt: FieldValue.serverTimestamp() });
    return { credited: reward };
  });
});

/* ── Chốt bài thi bỏ dở/quá hạn: toàn bộ tính bỏ trống (= sai) ──────── */
async function finalizeExpiredTest(testId) {
  await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tango_tests/${testId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists || tSnap.data().status !== "served") return;
    const t = tSnap.data();
    const cRef = db.doc(`tango_cycles/${t.cycleId}`);
    const cSnap = await tx.get(cRef);
    const n = t.questions.length;
    let delta = 0, meterAfter = null;
    if (cSnap.exists && cSnap.data().status === "active") {
      const c = cSnap.data();
      const meter = c.rewardMeter || 0;
      meterAfter = Math.max(0, meter - n * c.unitMinus);
      delta = meterAfter - meter;
      tx.update(cRef, { rewardMeter: meterAfter });
    }
    tx.update(tRef, {
      status: "graded", expired: true, late: true, answers: [],
      score: { right: 0, wrong: 0, blank: n }, delta, meterAfter,
      timeMs: Date.now() - t.servedAt.toMillis(), flagged: false,
      gradedAt: FieldValue.serverTimestamp(),
    });
  });
}

/* ── startOfficialTest: server chọn đề, đáp án ở lại server ─────────── */
exports.startOfficialTest = onCall(async (req) => {
  const auth = reqAuth(req);
  const cfg = await getCfg();
  const now = Date.now();

  // Bài dang dở? Còn hạn → cho làm tiếp; quá hạn → tự chốt (trống = sai).
  const pend = await db.collection("tango_tests")
    .where("uid", "==", auth.uid).where("status", "==", "served").limit(1).get();
  if (!pend.empty) {
    const d = pend.docs[0], t = d.data();
    if (now - t.servedAt.toMillis() <= t.budgetMs)
      return { testId: d.id, budgetMs: t.budgetMs, questions: t.questions, resumed: true };
    await finalizeExpiredTest(d.id);
  }

  return db.runTransaction(async (tx) => {
    const cyc = await getActiveCycle(tx, auth.uid);
    if (!cyc) throw new HttpsError("failed-precondition", "Chưa mở chu kỳ thưởng — vào Ví để mở.");
    if (cyc.endAt.toMillis() <= now)
      throw new HttpsError("failed-precondition", "Chu kỳ đã hết hạn — vào Ví để Chốt chu kỳ.");
    const today = jstDay(now);
    const takenToday = cyc.lastTestDay === today ? (cyc.lastTestCount || 0) : 0;
    if (takenToday >= cfg.dailyLimit)
      throw new HttpsError("resource-exhausted", "Hôm nay bạn đã dùng hết lượt thi. Mai thi tiếp nhé.");

    // Mục đủ điều kiện: học lần đầu cách đây >= eligibilityMinutes, chưa ra đề trong chu kỳ.
    const cutoff = Timestamp.fromMillis(now - cfg.eligibilityMinutes * 60e3);
    const itemsSnap = await tx.get(
      db.collection(`tango_userItems/${auth.uid}/items`)
        .where("learnedAt", "<=", cutoff).limit(300));
    const served = new Set(cyc.servedIds || []);
    const eligible = itemsSnap.docs.map((d) => d.id)
      .filter((id) => !served.has(id) && ITEMS.has(id));
    if (eligible.length < 4)
      throw new HttpsError("failed-precondition",
        `Chưa đủ mục "chín" để ra đề (cần ≥ 4, hiện có ${eligible.length}). ` +
        `Mục chín sau ${Math.round(cfg.eligibilityMinutes / 60)} giờ kể từ lần học đúng đầu tiên, và phải học khi đã đăng nhập.`);

    const pickIds = shuffle(eligible).slice(0, cfg.testSize);
    const questions = [], correct = [];
    for (const id of pickIds) {
      const it = ITEMS.get(id);
      const pool = shuffle(BANK.items.filter((x) => x.id !== id)).slice(0, 3);
      const opts = shuffle([it.m, ...pool.map((x) => x.m)]);
      questions.push({ itemId: id, w: it.w, r: it.r, opts });
      correct.push(opts.indexOf(it.m));
    }
    const budgetMs = questions.length * cfg.perQuestionSec * 1000 + cfg.graceSec * 1000;
    const tRef = db.collection("tango_tests").doc();
    tx.set(tRef, {
      uid: auth.uid, cycleId: cyc.ref.id, status: "served",
      servedAt: Timestamp.fromMillis(now), budgetMs, questions,
    });
    tx.set(db.doc(`tango_answers/${tRef.id}`), { uid: auth.uid, correct });
    tx.update(cyc.ref, {
      servedIds: FieldValue.arrayUnion(...pickIds),
      lastTestDay: today, lastTestCount: takenToday + 1,
      testsTaken: (cyc.testsTaken || 0) + 1,
    });
    return { testId: tRef.id, budgetMs, questions };
  });
});

/* ── submitOfficialTest: chấm 1 lần duy nhất, trong transaction ─────── */
exports.submitOfficialTest = onCall(async (req) => {
  const auth = reqAuth(req);
  const { testId } = req.data || {};
  if (typeof testId !== "string" || !testId)
    throw new HttpsError("invalid-argument", "Thiếu testId.");
  const raw = Array.isArray(req.data.answers) ? req.data.answers : [];
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const tRef = db.doc(`tango_tests/${testId}`);
    const [tSnap, aSnap] = await Promise.all([tx.get(tRef), tx.get(db.doc(`tango_answers/${testId}`))]);
    if (!tSnap.exists || tSnap.data().uid !== auth.uid)
      throw new HttpsError("not-found", "Không tìm thấy bài thi.");
    const t = tSnap.data();
    if (t.status !== "served")
      throw new HttpsError("failed-precondition", "Bài này đã được chấm rồi.");
    const correct = aSnap.exists ? aSnap.data().correct : [];
    const n = t.questions.length;
    const timeMs = now - t.servedAt.toMillis();
    const late = timeMs > t.budgetMs;
    // Quá hạn = toàn bộ tính bỏ trống → chặn chiêu "tạm dừng để tra nghĩa".
    const answers = late ? new Array(n).fill(-1)
      : Array.from({ length: n }, (_, i) => {
          const v = Number(raw[i]);
          return Number.isInteger(v) && v >= 0 && v <= 3 ? v : -1;
        });
    let right = 0, wrong = 0, blank = 0;
    answers.forEach((a, i) => { if (a < 0) blank++; else if (a === correct[i]) right++; else wrong++; });

    const cRef = db.doc(`tango_cycles/${t.cycleId}`);
    const cSnap = await tx.get(cRef);
    let delta = 0, meter = 0, cap = 0;
    if (cSnap.exists && cSnap.data().status === "active") {
      const c = cSnap.data();
      cap = c.cap;
      const cur = c.rewardMeter || 0;
      meter = Math.min(cap, Math.max(0, cur + right * c.unitPlus - (wrong + blank) * c.unitMinus));
      delta = meter - cur;
      tx.update(cRef, { rewardMeter: meter });
    }
    // Gắn cờ nghi vấn: trung bình dưới 1.5 giây/câu mà không muộn.
    const flagged = !late && timeMs < n * 1500;
    tx.update(tRef, {
      status: "graded", submittedAt: FieldValue.serverTimestamp(),
      answers, score: { right, wrong, blank }, delta, meterAfter: meter,
      timeMs, late, flagged,
      flagReason: flagged ? `${(timeMs / 1000).toFixed(1)}s cho ${n} câu` : null,
      gradedAt: FieldValue.serverTimestamp(),
    });
    return { right, wrong, blank, delta, meter, cap, late, correct };
  });
});

/* ── adminAdjustBalance: cửa DUY NHẤT chỉnh tay xu — luôn có bút toán ── */
exports.adminAdjustBalance = onCall(async (req) => {
  const a = reqAdmin(req);
  let { uid, email, amount, reason } = req.data || {};
  amount = Math.trunc(Number(amount));
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e6)
    throw new HttpsError("invalid-argument", "Số xu không hợp lệ.");
  if (!reason || !String(reason).trim())
    throw new HttpsError("invalid-argument", "Phải ghi lý do — nó nằm trong sổ cái.");
  try {
    const user = email ? await admin.auth().getUserByEmail(String(email).trim())
                       : await admin.auth().getUser(String(uid).trim());
    uid = user.uid; email = user.email || null;
  } catch (e) {
    throw new HttpsError("not-found", "Không tìm thấy người dùng này (họ đã đăng nhập app lần nào chưa?).");
  }
  return db.runTransaction(async (tx) => {
    const wSnap = await tx.get(db.doc(`tango_wallets/${uid}`));
    const r = ledgerWrite(tx, uid, wSnap, {
      type: "admin_adjust", amount, reason: String(reason).trim(),
      createdBy: `admin:${a.token.email}`, email,
    });
    return { uid, balance: r.balance, seq: r.seq };
  });
});

/* ── auditWallet: đối chiếu ví == tổng sổ cái ───────────────────────── */
exports.auditWallet = onCall(async (req) => {
  reqAdmin(req);
  const uid = String((req.data || {}).uid || "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "Thiếu uid.");
  const [wSnap, lSnap] = await Promise.all([
    db.doc(`tango_wallets/${uid}`).get(),
    db.collection(`tango_wallets/${uid}/ledger`).get(),
  ]);
  const balance = wSnap.exists ? wSnap.data().balance || 0 : 0;
  let sum = 0;
  lSnap.forEach((d) => { sum += d.data().amount || 0; });
  return { ok: balance === sum, balance, sum, entries: lSnap.size };
});
