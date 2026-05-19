# LEO Handover Simulation Dashboard

Ứng dụng mô phỏng handover cho mạng vệ tinh LEO gồm satellite, gateway và router. Dashboard dùng dữ liệu Hypatia enriched CSV, TLE, SGP4 và CesiumJS để hiển thị satellite ground track, gateway/router, active links, traffic mô phỏng và lịch sử handover.

## 1. Yêu cầu

Cài sẵn:

- Node.js 20 hoặc mới hơn.
- npm, đi kèm Node.js.

Kiểm tra nhanh:

```bash
node --version
npm --version
```

## 2. Chạy project từ đầu

Từ thư mục project:

```bash
cd animation
npm install
npm run dev
```

Sau khi terminal hiện Vite ready, mở:

```text
http://localhost:5173/
```

Backend API chạy tại:

```text
http://localhost:3001/
```

Nếu port `3001` hoặc `5173` đang bị chiếm, tắt process cũ rồi chạy lại:

```bash
lsof -ti :3001 -sTCP:LISTEN | xargs -r kill
lsof -ti :5173 -sTCP:LISTEN | xargs -r kill
npm run dev
```

## 3. Chạy test và build

Unit/API test:

```bash
npm run test
```

Build production:

```bash
npm run build
```

Chạy production preview:

```bash
npm run preview
```

Smoke test UI desktop/mobile:

```bash
npx playwright install chromium
npm run test:e2e
```

Lệnh `npx playwright install chromium` chỉ cần chạy một lần trên máy mới.

## 4. Dữ liệu đi kèm repo

Các file mặc định đã nằm trong thư mục project, nên người khác pull code về có thể chạy ngay sau `npm install`.

- `ground_stations_vnu.basic.txt`: tọa độ gateway/router.
- `run001_handover_schedule_enriched.csv`: log handover enriched.
- `run001_routing_db_enriched.csv`: routing table enriched theo từng giây.
- `data/tle.txt`: TLE của 40 vệ tinh.
- `data/start_date.txt`: thời điểm bắt đầu mô phỏng.

Backend mặc định đọc các file trên. Nếu muốn dùng dataset khác, override bằng env var:

```bash
GROUND_STATIONS_PATH=/path/to/ground.txt \
HANDOVER_CSV_PATH=/path/to/handover.csv \
ROUTING_CSV_PATH=/path/to/routing.csv \
TLE_PATH=/path/to/tle.txt \
START_DATE_PATH=/path/to/start_date.txt \
npm run dev
```

## 5. Cấu trúc code

- `server/`: Express API, parser dữ liệu, OOP simulation engine.
- `src/`: React UI, Cesium map, dashboard components.
- `tests/`: Vitest unit/API tests và Playwright smoke tests.
- `data/`: TLE và start date local cho SGP4.
- `dist/`: output build production, được tạo sau `npm run build`.

## 6. API chính

- `GET /api/manifest`: metadata, danh sách node/satellite, time range, data paths.
- `GET /api/frame?t=123`: frame tổng thể tại giây `t`.
- `GET /api/nodes/:id/frame?t=123`: frame chi tiết của một gateway/router.
- `GET /api/handovers?from=&to=&nodeId=`: lịch sử handover đã normalize.

Ví dụ:

```bash
curl 'http://localhost:3001/api/frame?t=210'
curl 'http://localhost:3001/api/nodes/40/frame?t=210'
```

## 7. Cách dùng dashboard

1. Mở `http://localhost:5173/`.
2. Bấm `Start`.
3. Dùng control dock phía dưới để pause/resume, reset, chọn tốc độ `1x/2x/4x`, hoặc kéo timeline.
4. Tab `System` hiển thị mạng tổng thể quanh Việt Nam, active links, tracked satellite plane, upcoming/recent handovers.
5. Tab `Router & Gateway` chọn từng node để xem role, elevation, loss/SINR, traffic, active routes và visible satellites.

## 8. Ghi chú mô phỏng

- Traffic mô phỏng: mỗi routing row thử gửi `10 bytes/second`; xác suất thành công lấy từ SINR band.
- Handover CSV có dòng trùng theo route/pair nên backend normalize trước khi hiển thị.
- Vị trí vệ tinh dùng SGP4 từ `data/tle.txt`.
- Backend tự hiệu chỉnh offset thời gian nhỏ để khớp TLE với lat/lon enriched trong CSV.
- Label satellite active dùng `routed flows`, ví dụ `VNUSAT-021 / 30 routed flows`; đây là số route đang đi qua vệ tinh, không phải dải vệ tinh 021-030.
