// (Tuỳ chọn) Gán custom claim admin=true cho một tài khoản.
// Rules và functions đã nhận admin qua email ks235278@kaichi.ac.jp,
// nên script này chỉ cần khi muốn đổi email hoặc thêm admin thứ hai.
//
// Cách chạy:
//   1. Firebase Console → Project settings → Service accounts → Generate new private key
//   2. cd tango/functions && npm install
//   3. node ../tools/set_admin.js duong-dan/serviceAccount.json email@can-gan.com
"use strict";
const admin = require("firebase-admin");
const [, , keyPath, email] = process.argv;
if (!keyPath || !email) {
  console.error("Cách dùng: node set_admin.js <serviceAccount.json> <email>");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require(require("path").resolve(keyPath))) });
admin.auth().getUserByEmail(email)
  .then((u) => admin.auth().setCustomUserClaims(u.uid, { admin: true }).then(() => u))
  .then((u) => { console.log(`OK: ${email} (uid ${u.uid}) đã có claim admin=true. User cần đăng nhập lại.`); process.exit(0); })
  .catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
