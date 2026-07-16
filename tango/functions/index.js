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
  eligibilityMinutes: 3 * 24 * 60, // mục "chín" sau 3 ngày (dev: admin đặt = 3 phút)
  perQuestionSec: 8,
  graceSec: 15,
  maxStake: 500,          // cược tối đa / bài thi
  dailyWinCap: 3000,      // trần THẮNG RÒNG từ cược / ngày (JST) — chặn lạm phát xu
  dblWindowSec: 45,       // cửa sổ quyết định + trả lời kèo tất tay
  hardModeThreshold: 40,  // ≥ ngần này mục "chín" → chuyển sang chế độ "hay sai nhất";
                          // dưới ngưỡng → ra đề từ CHƯA TỪNG HỌC (khó nhất với người mới)
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
/** Mục "chín" của user (kèm due/wrong để ưu tiên ôn — dữ liệu này client ghi được,
 *  nên chỉ dùng để XẾP THỨ TỰ, không bao giờ dùng để tính tiền trực tiếp). */
async function getMatureItems(tx, uid, cfg, now) {
  const cutoff = Timestamp.fromMillis(now - cfg.eligibilityMinutes * 60e3);
  const snap = await tx.get(
    db.collection(`tango_userItems/${uid}/items`)
      .where("learnedAt", "<=", cutoff).limit(300));
  return snap.docs.filter((d) => ITEMS.has(d.id))
    .map((d) => ({ id: d.id, due: Number(d.data().due) || 0, wrong: Number(d.data().wrong) || 0 }));
}
/** Mọi mục user ĐÃ TỪNG học (bất kể chín chưa) — để loại ra khi ra đề "từ chưa
 *  từng học". Chỉ gọi ở chế độ người-mới nên collection còn nhỏ → đọc rẻ. */
async function getTouchedIds(tx, uid) {
  const snap = await tx.get(
    db.collection(`tango_userItems/${uid}/items`).select().limit(900));
  return new Set(snap.docs.map((d) => d.id));
}
/** Bộ đếm SAI do SERVER ghi khi chấm bài (client không sửa được) — dùng để
 *  chọn "câu hay sai nhất". KHÁC với field wrong ở tango_userItems (client ghi). */
async function getUserStats(tx, uid) {
  const s = await tx.get(db.doc(`tango_stats/${uid}`));
  const d = s.exists ? s.data() : {};
  return { seen: d.seen || {}, miss: d.miss || {} };
}
function buildQuestion(id) {
  const it = ITEMS.get(id);
  const pool = shuffle(BANK.items.filter((x) => x.id !== id)).slice(0, 3);
  const opts = shuffle([it.m, ...pool.map((x) => x.m)]);
  return { q: { itemId: id, w: it.w, r: it.r, opts }, correct: opts.indexOf(it.m) };
}
/** Thang trả cược theo độ chính xác + chuỗi + câu hoàng kim. */
/* Thang trả cược — SIẾT 2026-07-16: chỉ ≥90% mới có lãi, 80% hoà vốn,
 * dưới 80% là lỗ. Cộng với việc ra đề toàn từ khó → thắng xu khó hơn hẳn. */
function payoutMult(right, n, maxStreak, goldenHit) {
  const acc = n ? right / n : 0;
  let base = 0;
  if (right === n && n > 0) base = 3;    // tuyệt đối — jackpot
  else if (acc >= 0.9) base = 1.6;       // (cũ ×2)
  else if (acc >= 0.8) base = 1.0;       // (cũ ×1.5) → hoà vốn
  else if (acc >= 0.7) base = 0.5;       // (cũ ×1.1) → giờ LỖ
  else if (acc >= 0.6) base = 0.2;       // (cũ ×0.5)
  if (base <= 0) return { base: 0, combo: 0, golden: 0, total: 0 };
  const combo = maxStreak >= 10 ? 0.2 : maxStreak >= 5 ? 0.1 : 0;
  const golden = goldenHit ? 0.4 : 0;
  return { base, combo, golden, total: base + combo + golden };
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
    // Chỉ mục "lần đầu trong chu kỳ" (metered) mới đụng thang thưởng.
    const nM = Array.isArray(t.meteredIds) ? t.meteredIds.length : n;
    let delta = 0, meterAfter = null;
    if (cSnap.exists && cSnap.data().status === "active") {
      const c = cSnap.data();
      const meter = c.rewardMeter || 0;
      meterAfter = Math.max(0, meter - nM * c.unitMinus);
      delta = meterAfter - meter;
      tx.update(cRef, { rewardMeter: meterAfter });
    }
    tx.update(tRef, {
      status: "graded", expired: true, late: true, answers: [],
      score: { right: 0, wrong: 0, blank: n }, delta, meterAfter,
      payout: 0, // tiền cược (nếu có) đã trừ lúc vào bàn — bỏ dở là mất
      timeMs: Date.now() - t.servedAt.toMillis(), flagged: false,
      gradedAt: FieldValue.serverTimestamp(),
    });
  });
}

/* ── startOfficialTest: server chọn đề, đáp án ở lại server ───────────
 * KHÔNG giới hạn số bài/ngày. Nhận { stake }: đặt cược trừ ví ngay khi vào
 * bàn (bỏ dở = mất cược). Mục chưa ra đề trong chu kỳ (metered) ăn thang
 * thưởng; hết mục mới thì ra lại mục cũ — ưu tiên mục quá hạn ôn lâu nhất
 * (ôn cách quãng), các mục này chỉ ăn/thua tiền cược. */
exports.startOfficialTest = onCall(async (req) => {
  const auth = reqAuth(req);
  const cfg = await getCfg();
  const now = Date.now();
  const stake = Math.trunc(Number((req.data || {}).stake)) || 0;
  if (stake < 0 || stake > cfg.maxStake)
    throw new HttpsError("invalid-argument", `Mức cược phải từ 0 đến ${cfg.maxStake} xu.`);

  // Bài dang dở? Còn hạn → cho làm tiếp; quá hạn → tự chốt (trống = sai).
  const pend = await db.collection("tango_tests")
    .where("uid", "==", auth.uid).where("status", "==", "served").limit(1).get();
  if (!pend.empty) {
    const d = pend.docs[0], t = d.data();
    if (now - t.servedAt.toMillis() <= t.budgetMs)
      return { testId: d.id, budgetMs: t.budgetMs, questions: t.questions,
               goldenIdx: t.goldenIdx ?? -1, stake: t.stake || 0, resumed: true };
    await finalizeExpiredTest(d.id);
  }

  return db.runTransaction(async (tx) => {
    const cyc = await getActiveCycle(tx, auth.uid);
    if (!cyc) throw new HttpsError("failed-precondition", "Chưa mở chu kỳ thưởng — vào Ví để mở.");
    if (cyc.endAt.toMillis() <= now)
      throw new HttpsError("failed-precondition", "Chu kỳ đã hết hạn — vào Ví để Chốt chu kỳ.");

    const wSnap = await tx.get(db.doc(`tango_wallets/${auth.uid}`));
    const w = wSnap.exists ? wSnap.data() : {};
    const today = jstDay(now);
    if (stake > 0) {
      if ((w.balance || 0) < stake)
        throw new HttpsError("failed-precondition", `Không đủ xu để cược (đang có ${w.balance || 0}).`);
      const gNet = w.gDay === today ? (w.gNet || 0) : 0;
      if (gNet >= cfg.dailyWinCap)
        throw new HttpsError("resource-exhausted",
          `Bàn cược hôm nay đã đóng — bạn thắng ròng +${gNet} xu (trần +${cfg.dailyWinCap}/ngày JST). ` +
          `Thi tự do (cược 0) vẫn không giới hạn.`);
    }

    // ── Chọn đề theo ĐỘ SÂU HỌC — luôn nhắm chỗ yếu nhất, KHÔNG chặn ai ──
    const mature = await getMatureItems(tx, auth.uid, cfg, now);
    const served = new Set(cyc.servedIds || []);
    let pickIds = [], meteredIds = [], mode;
    if (mature.length >= cfg.hardModeThreshold) {
      // HỌC NHIỀU → dồn vào những câu HAY SAI NHẤT (bộ đếm của server, không gian lận được).
      mode = "weak";
      const { miss } = await getUserStats(tx, auth.uid);
      const ranked = shuffle([...mature]).sort((a, b) =>
        ((miss[b.id] || 0) - (miss[a.id] || 0)) || (a.due - b.due));
      pickIds = ranked.slice(0, cfg.testSize).map((m) => m.id);
      meteredIds = pickIds.filter((id) => !served.has(id));
    } else {
      // HỌC ÍT → ra đề từ CHƯA TỪNG HỌC. Không tính thang thưởng chu kỳ
      // (meteredIds rỗng) — chỉ ăn/thua tiền cược.
      mode = "unseen";
      const touched = await getTouchedIds(tx, auth.uid);
      pickIds = shuffle(BANK.items.filter((it) => !touched.has(it.id))
        .map((it) => it.id)).slice(0, cfg.testSize);
      if (pickIds.length < cfg.testSize) {   // đã đụng gần hết bank → đệm bằng mục chín
        const got = new Set(pickIds);
        pickIds = pickIds.concat(shuffle(mature.map((m) => m.id))
          .filter((id) => !got.has(id)).slice(0, cfg.testSize - pickIds.length));
      }
    }
    if (pickIds.length < 4)
      throw new HttpsError("failed-precondition", "Chưa đủ dữ liệu để ra đề — thử lại sau.");
    shuffle(pickIds);

    const questions = [], correct = [];
    for (const id of pickIds) {
      const b = buildQuestion(id);
      questions.push(b.q); correct.push(b.correct);
    }
    const goldenIdx = Math.floor(Math.random() * questions.length);
    const budgetMs = questions.length * cfg.perQuestionSec * 1000 + cfg.graceSec * 1000;
    const tRef = db.collection("tango_tests").doc();
    if (stake > 0)
      ledgerWrite(tx, auth.uid, wSnap, {
        type: "test_stake", amount: -stake, refId: tRef.id,
        reason: "đặt cược bài thi", email: auth.token.email || null,
      });
    tx.set(tRef, {
      uid: auth.uid, cycleId: cyc.ref.id, status: "served",
      servedAt: Timestamp.fromMillis(now), budgetMs, questions,
      stake, goldenIdx, meteredIds, mode,
    });
    tx.set(db.doc(`tango_answers/${tRef.id}`), { uid: auth.uid, correct });
    tx.update(cyc.ref, {
      ...(meteredIds.length ? { servedIds: FieldValue.arrayUnion(...meteredIds) } : {}),
      testsTaken: (cyc.testsTaken || 0) + 1,
    });
    return { testId: tRef.id, budgetMs, questions, goldenIdx, stake };
  });
});

/* ── submitOfficialTest: chấm 1 lần duy nhất, trong transaction ───────
 * Trả cược theo thang ×, cộng chuỗi 🔥 + câu hoàng kim ✨, kẹp trần thắng
 * ròng/ngày, và (nếu thắng) mở kèo TẤT TAY nhân đôi. */
exports.submitOfficialTest = onCall(async (req) => {
  const auth = reqAuth(req);
  const cfg = await getCfg();
  const { testId } = req.data || {};
  if (typeof testId !== "string" || !testId)
    throw new HttpsError("invalid-argument", "Thiếu testId.");
  const raw = Array.isArray(req.data.answers) ? req.data.answers : [];
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const tRef = db.doc(`tango_tests/${testId}`);
    const aRef = db.doc(`tango_answers/${testId}`);
    const [tSnap, aSnap] = await Promise.all([tx.get(tRef), tx.get(aRef)]);
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
    // Chuỗi đúng dài nhất (theo thứ tự làm bài).
    let maxStreak = 0, streak = 0;
    answers.forEach((a, i) => {
      if (a >= 0 && a === correct[i]) { streak++; if (streak > maxStreak) maxStreak = streak; }
      else streak = 0;
    });

    // Thang thưởng chu kỳ: CHỈ mục ra đề lần đầu trong chu kỳ (metered) được tính.
    const meteredSet = new Set(Array.isArray(t.meteredIds)
      ? t.meteredIds : t.questions.map((q) => q.itemId));
    let rightM = 0, badM = 0;
    answers.forEach((a, i) => {
      if (!meteredSet.has(t.questions[i].itemId)) return;
      if (a >= 0 && a === correct[i]) rightM++; else badM++;
    });
    const cRef = db.doc(`tango_cycles/${t.cycleId}`);
    const cSnap = await tx.get(cRef);
    const wRef = db.doc(`tango_wallets/${auth.uid}`);
    const wSnap = await tx.get(wRef);

    // Tiền cược → trả thưởng.
    const stakeAmt = t.stake || 0;
    const goldenIdx = Number.isInteger(t.goldenIdx) ? t.goldenIdx : -1;
    const goldenHit = goldenIdx >= 0 && answers[goldenIdx] === correct[goldenIdx];
    const w = wSnap.exists ? wSnap.data() : {};
    const today = jstDay(now);
    let gNet = w.gDay === today ? (w.gNet || 0) : 0;
    let mult = { base: 0, combo: 0, golden: 0, total: 0 }, payout = 0, capped = false;
    if (stakeAmt > 0 && !late) {
      mult = payoutMult(right, n, maxStreak, goldenHit);
      payout = Math.round(stakeAmt * mult.total);
      const netWin = payout - stakeAmt;
      if (netWin > 0 && gNet + netWin > cfg.dailyWinCap) {
        payout = stakeAmt + Math.max(0, cfg.dailyWinCap - gNet);
        capped = true;
      }
    }

    // Kèo TẤT TAY: chỉ khi có tiền thắng để đặt. Chọn từ khó nhất (nhiều lần
    // sai nhất) ngoài đề vừa thi — cú gọi hồi trí nhớ đắt giá nhất.
    let dbl = null, dblCorrect = -1;
    if (stakeAmt > 0 && !late && payout > 0) {
      const mature = await getMatureItems(tx, auth.uid, cfg, now);
      const { miss } = await getUserStats(tx, auth.uid);   // đếm ở server, không gian lận được
      const inTest = new Set(t.questions.map((q) => q.itemId));
      const cand = mature.filter((m) => !inTest.has(m.id))
        .sort((a, b) => (miss[b.id] || 0) - (miss[a.id] || 0)).slice(0, 5);
      if (cand.length) {
        const b = buildQuestion(cand[Math.floor(Math.random() * cand.length)].id);
        dbl = { q: b.q, amount: payout, status: "offered",
                expiresAt: Timestamp.fromMillis(now + cfg.dblWindowSec * 1000) };
        dblCorrect = b.correct;
      }
    }

    // ── Ghi (mọi read đã xong) ──
    let delta = 0, meter = 0, cap = 0;
    if (cSnap.exists && cSnap.data().status === "active") {
      const c = cSnap.data();
      cap = c.cap;
      const cur = c.rewardMeter || 0;
      meter = Math.min(cap, Math.max(0, cur + rightM * c.unitPlus - badM * c.unitMinus));
      delta = meter - cur;
      tx.update(cRef, { rewardMeter: meter });
    }
    if (payout > 0)
      ledgerWrite(tx, auth.uid, wSnap, {
        type: "test_payout", amount: payout, refId: testId,
        reason: `trả cược ×${mult.total.toFixed(2)}${capped ? " (kẹp trần ngày)" : ""}`,
        email: auth.token.email || null,
      });
    if (stakeAmt > 0) {
      gNet += payout - stakeAmt;
      tx.set(wRef, { gDay: today, gNet }, { merge: true });
    }
    if (dbl) tx.set(aRef, { dblCorrect }, { merge: true });
    // Bộ đếm SAI của server — nguồn DUY NHẤT đáng tin để chọn "câu hay sai nhất".
    // Bài quá hạn (toàn bỏ trống) không phản ánh trí nhớ nên không tính.
    if (!late && n) {
      const seenInc = {}, missInc = {};
      answers.forEach((a, i) => {
        const id = t.questions[i].itemId;
        seenInc[id] = FieldValue.increment(1);
        if (a < 0 || a !== correct[i]) missInc[id] = FieldValue.increment(1);
      });
      tx.set(db.doc(`tango_stats/${auth.uid}`),
        { seen: seenInc, miss: missInc, updatedAt: FieldValue.serverTimestamp() },
        { merge: true });
    }
    // Gắn cờ nghi vấn: trung bình dưới 1.5 giây/câu mà không muộn.
    const flagged = !late && timeMs < n * 1500;
    tx.update(tRef, {
      status: "graded", submittedAt: FieldValue.serverTimestamp(),
      answers, score: { right, wrong, blank }, delta, meterAfter: meter,
      payout, mult, maxStreak, goldenHit, capped,
      ...(dbl ? { dbl } : {}),
      timeMs, late, flagged,
      flagReason: flagged ? `${(timeMs / 1000).toFixed(1)}s cho ${n} câu` : null,
      gradedAt: FieldValue.serverTimestamp(),
    });
    return { right, wrong, blank, delta, meter, cap, late, correct,
             stake: stakeAmt, payout, mult, maxStreak, goldenIdx, goldenHit,
             capped, gNet, winCap: cfg.dailyWinCap,
             dbl: dbl ? { q: dbl.q, amount: dbl.amount, windowSec: cfg.dblWindowSec } : null };
  });
});

/* ── resolveDouble: kèo TẤT TAY — đúng ×2 tiền thắng, sai về 0 ──────── */
exports.resolveDouble = onCall(async (req) => {
  const auth = reqAuth(req);
  const cfg = await getCfg();
  const { testId } = req.data || {};
  if (typeof testId !== "string" || !testId)
    throw new HttpsError("invalid-argument", "Thiếu testId.");
  const ans = Math.trunc(Number((req.data || {}).answer));
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const tRef = db.doc(`tango_tests/${testId}`);
    const wRef = db.doc(`tango_wallets/${auth.uid}`);
    const [tSnap, aSnap, wSnap] = await Promise.all([
      tx.get(tRef), tx.get(db.doc(`tango_answers/${testId}`)), tx.get(wRef)]);
    if (!tSnap.exists || tSnap.data().uid !== auth.uid)
      throw new HttpsError("not-found", "Không tìm thấy bài thi.");
    const t = tSnap.data();
    if (!t.dbl || t.dbl.status !== "offered")
      throw new HttpsError("failed-precondition", "Không có kèo tất tay đang mở cho bài này.");
    if (now > t.dbl.expiresAt.toMillis()) {
      tx.update(tRef, { "dbl.status": "expired" });
      return { expired: true };
    }
    const amount = t.dbl.amount || 0;
    const correctIdx = aSnap.exists && Number.isInteger(aSnap.data().dblCorrect)
      ? aSnap.data().dblCorrect : -1;
    const win = Number.isInteger(ans) && ans >= 0 && ans === correctIdx;
    const w = wSnap.exists ? wSnap.data() : {};
    const today = jstDay(now);
    let gNet = w.gDay === today ? (w.gNet || 0) : 0;
    let delta = 0;
    if (win) {
      delta = amount;
      if (gNet + delta > cfg.dailyWinCap) delta = Math.max(0, cfg.dailyWinCap - gNet);
      if (delta > 0)
        ledgerWrite(tx, auth.uid, wSnap, {
          type: "double_win", amount: delta, refId: testId,
          reason: "tất tay thắng — nhân đôi tiền thắng", email: auth.token.email || null,
        });
    } else {
      delta = -Math.min(amount, w.balance || 0);
      if (delta < 0)
        ledgerWrite(tx, auth.uid, wSnap, {
          type: "double_loss", amount: delta, refId: testId,
          reason: "tất tay thua — mất tiền thắng", email: auth.token.email || null,
        });
    }
    gNet += delta;
    tx.set(wRef, { gDay: today, gNet }, { merge: true });
    tx.update(tRef, {
      "dbl.status": win ? "won" : "lost",
      "dbl.answer": Number.isInteger(ans) ? ans : -1,
      "dbl.delta": delta,
      "dbl.resolvedAt": FieldValue.serverTimestamp(),
    });
    return { win, delta, correctIdx, capped: win && delta < amount };
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
