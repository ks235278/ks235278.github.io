# 単語 Tango — Học từ vựng JLPT có thưởng (xu ảo)

Học miễn phí không giới hạn. Thi chính thức **không giới hạn số bài** — có bàn cược xu kiểu sòng bạc.
Toàn bộ tiền là **xu ảo** — chỉ Cloud Functions và admin ghi được, client chỉ đọc.

## Luật chơi

- **Học**: khuôn duy nhất — từ to giữa màn + furigana, chọn nghĩa tiếng Việt, xong hiện gói ghi nhớ (ví dụ có furigana + dịch + định nghĩa JP). Ôn theo lịch cách quãng (10 phút → 1 → 3 → 7 → 14 ngày).
- **Mục "chín"**: một mục chỉ đủ điều kiện vào đề thi thật sau `eligibilityMinutes` (mặc định 3 ngày) kể từ lần trả lời đúng đầu tiên **khi đã đăng nhập**. Đây là cách đo trí nhớ dài hạn.
- **Chu kỳ thưởng**: mở bằng phí 1.000 xu, chạy 30 ngày. Thang thưởng chạy 0 → 200 xu (20% phí): mỗi mục đúng +2 xu, sai/bỏ trống −1 xu, không âm vào vốn. **Chỉ mục ra đề LẦN ĐẦU trong chu kỳ** được tính vào thang. Hết hạn thì Chốt chu kỳ để nhận thưởng vào ví.
- **Thi chính thức — KHÔNG giới hạn số bài/ngày**: máy chủ chọn tối đa 20 mục chín, ưu tiên mục chưa ra đề; hết mục mới thì ra lại mục **quá hạn ôn lâu nhất** (mỗi bài thi = một vòng ôn cách quãng). 8 giây/câu. Bỏ dở hoặc nộp quá hạn = các câu tính bỏ trống (sai) **và mất tiền cược**.
- **Bàn cược (xu ảo, server chấm)**: đặt cược 0 → `maxStake` (mặc định 500) trước mỗi bài, trừ ví ngay khi vào bàn. Trả thưởng theo độ chính xác: 100% ×3 · ≥90% ×2 · ≥80% ×1.5 · ≥70% ×1.1 · ≥60% ×0.5 · dưới 60% mất sạch. Cộng thêm: chuỗi đúng ≥5 +10% / ≥10 +25%, **Câu Hoàng Kim** ✨ (1 câu/bài, báo trước) +50%.
- **Kèo TẤT TAY**: thắng cược xong được mời 1 câu — máy chủ rút **từ hay sai nhất của bạn** ngoài đề vừa thi. Đúng: nhân đôi tiền thắng. Sai: mất sạch tiền vừa thắng. Cửa sổ `dblWindowSec` (45s), chỉ 1 lần/bài.
- **Trần thắng ròng/ngày**: `dailyWinCap` (mặc định +3.000 xu/ngày JST) — chạm trần thì bàn cược đóng đến 0h, thi tự do (cược 0) vẫn vô hạn. Đây là van chống lạm phát xu thay cho giới hạn số bài cũ.
- **Nhớ là gốc**: kết quả thi thật *và* thi thử đều nạp ngược vào SRS (sai → tụt hộp, quay lại phần Học sớm); câu sai hiện luôn gói ghi nhớ ngay màn kết quả; câu tất tay thua hiện đáp án đúng.

## An ninh (tóm tắt)

- Client **không ghi được** `tango_wallets`, `ledger`, `tango_cycles`, `tango_tests`; `tango_answers` không ai đọc/ghi từ client — xem `firestore.rules`.
- Đáp án đúng không bao giờ rời server (kể cả câu tất tay); đề xáo lựa chọn bằng bản đồ phía server.
- Sổ cái append-only có `seq` liên tục; bút toán mới: `test_stake`, `test_payout`, `double_win`, `double_loss`. Nút "kiểm toán" trong #admin đối chiếu ví ↔ tổng sổ.
- `learnedAt` bị rules ép `== request.time` → không lùi ngày để mục chín sớm.
- Chấm trong transaction, mỗi bài đúng 1 lần; nộp nhanh bất thường (<1,5s/câu) bị gắn cờ cho admin.
- Kinh tế xu bị chặn 2 van: thang thưởng chu kỳ chỉ tính mục lần đầu (trần 200/chu kỳ) + trần thắng ròng cược `dailyWinCap`/ngày. Thi vô hạn không đúc thêm xu vô hạn.
- Thứ tự ưu tiên mục ôn lại và việc chọn "từ hay sai nhất" cho kèo tất tay dựa trên `tango_userItems` (client ghi được) — chấp nhận vì dữ liệu này chỉ xếp thứ tự, không tính tiền, và mọi đường tiền đã có trần ngày.
- Admin chỉnh xu duy nhất qua `adminAdjustBalance` (bắt buộc có lý do, thành bút toán `admin_adjust`).
- Giới hạn thừa nhận: nội dung học công khai nên không chặn tuyệt đối tra cứu — bù bằng 8s/câu, trần thưởng, trần thắng ngày và quyền admin thu hồi.

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
├── data/bank.json      # 500 mục = 200 trích từ DATA n1-quiz (tools/extract_bank.py)
│                       #   + 300 tự sinh (tools/add_words.py ← tools/new_words/*.json,
│                       #   kho lưu data/extra_bank.json — re-extract không mất)
├── firestore.rules     # rules HỢP NHẤT cả project (n1-quiz + tango)
├── firebase.json       # deploy functions/rules từ thư mục này
├── functions/          # vùng tin cậy: openCycle, settleCycle, startOfficialTest,
│                       #   submitOfficialTest, resolveDouble, adminAdjustBalance, auditWallet
└── tools/
    ├── extract_bank.py # dựng lại bank.json (chạy: py -3 -X utf8 tools/extract_bank.py)
    └── set_admin.js    # (tuỳ chọn) gán claim admin cho email khác
```

## Chưa làm (đợt sau)

- App Check (reCAPTCHA) để chặn request ngoài app.
- Bank nhiều cấp độ N5–N1 + nghĩa tiếng Việt cho 8.385 từ index.
- Nếu chuyển sang tiền thật: dùng khung pháp lý Nhật đã chốt trong thiết kế (không ăn vào vốn, giảm giá chu kỳ sau, お祝い金 khi đỗ JLPT thật).
