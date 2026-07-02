# 単語 Tango — Học từ vựng JLPT có thưởng (xu ảo)

Học miễn phí không giới hạn. Thi chính thức để thang thưởng nhảy theo trí nhớ.
Toàn bộ tiền là **xu ảo** — chỉ Cloud Functions và admin ghi được, client chỉ đọc.

## Luật chơi

- **Học**: khuôn duy nhất — từ to giữa màn + furigana, chọn nghĩa tiếng Việt, xong hiện gói ghi nhớ (ví dụ có furigana + dịch + định nghĩa JP). Ôn theo lịch cách quãng (10 phút → 1 → 3 → 7 → 14 ngày).
- **Mục "chín"**: một mục chỉ đủ điều kiện vào đề thi thật sau `eligibilityMinutes` (mặc định 3 ngày) kể từ lần trả lời đúng đầu tiên **khi đã đăng nhập**. Đây là cách đo trí nhớ dài hạn.
- **Chu kỳ thưởng**: mở bằng phí 1.000 xu, chạy 30 ngày. Thang thưởng chạy 0 → 200 xu (20% phí): mỗi mục đúng trong thi thật +2 xu, sai/bỏ trống −1 xu, không âm vào vốn. Hết hạn thì Chốt chu kỳ để nhận thưởng vào ví.
- **Thi chính thức**: máy chủ chọn tối đa 20 mục chín, 8 giây/câu, 1 bài/ngày (JST), mỗi mục chỉ ra đề 1 lần/chu kỳ. Bỏ dở hoặc nộp quá hạn = các câu tính bỏ trống (sai).

## An ninh (tóm tắt)

- Client **không ghi được** `tango_wallets`, `ledger`, `tango_cycles`, `tango_tests`; `tango_answers` không ai đọc/ghi từ client — xem `firestore.rules`.
- Đáp án đúng không bao giờ rời server; đề xáo lựa chọn bằng bản đồ phía server.
- Sổ cái append-only có `seq` liên tục; nút "kiểm toán" trong #admin đối chiếu ví ↔ tổng sổ.
- `learnedAt` bị rules ép `== request.time` → không lùi ngày để mục chín sớm.
- Chấm trong transaction, mỗi bài đúng 1 lần; nộp nhanh bất thường (<1,5s/câu) bị gắn cờ cho admin.
- Admin chỉnh xu duy nhất qua `adminAdjustBalance` (bắt buộc có lý do, thành bút toán `admin_adjust`).
- Giới hạn thừa nhận: nội dung học công khai nên không chặn tuyệt đối tra cứu — bù bằng 8s/câu, trần thưởng và quyền admin thu hồi.

## Triển khai

Trang tĩnh đã chạy ngay khi push (GitHub Pages). Phần server làm 1 lần:

1. **Rules**: Firebase Console → Firestore → Rules → dán toàn bộ `tango/firestore.rules` (đã gộp nguyên phần N1 quiz) → Publish.
2. **Functions** (cần gói Blaze — miễn phí ở quy mô nhỏ, có free tier):
   ```
   npm install -g firebase-tools
   firebase login
   cd tango/functions && npm install && cd ..
   firebase deploy --only functions
   ```
3. **Cấp xu khởi điểm**: mở app → đăng nhập bằng email admin → vào `#admin` → Cấp xu (ví dụ 2.000) cho email người dùng (người đó phải đăng nhập app ít nhất 1 lần trước).
4. **Chạy thử nhanh (dev)**: trong `#admin` đặt `eligibilityMinutes = 3` → học vài từ khi đã đăng nhập → 3 phút sau mở chu kỳ và Vào thi. Nhớ trả về `4320` khi chạy thật.

## Cấu trúc

```
tango/
├── index.html          # toàn bộ app (client)
├── data/bank.json      # 200 mục trích từ DATA n1-quiz (tools/extract_bank.py)
├── firestore.rules     # rules HỢP NHẤT cả project (n1-quiz + tango)
├── firebase.json       # deploy functions/rules từ thư mục này
├── functions/          # vùng tin cậy: openCycle, settleCycle, startOfficialTest,
│                       #   submitOfficialTest, adminAdjustBalance, auditWallet
└── tools/
    ├── extract_bank.py # dựng lại bank.json (chạy: py -3 -X utf8 tools/extract_bank.py)
    └── set_admin.js    # (tuỳ chọn) gán claim admin cho email khác
```

## Chưa làm (đợt sau)

- App Check (reCAPTCHA) để chặn request ngoài app.
- Bank nhiều cấp độ N5–N1 + nghĩa tiếng Việt cho 8.385 từ index.
- Nếu chuyển sang tiền thật: dùng khung pháp lý Nhật đã chốt trong thiết kế (không ăn vào vốn, giảm giá chu kỳ sau, お祝い金 khi đỗ JLPT thật).
