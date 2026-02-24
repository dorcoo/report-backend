const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg'); // SQLite 대신 PostgreSQL 사용

const app = express();

// 1. 데이터베이스 연결 (Supabase 등에서 받은 주소를 환경변수나 직접 입력)
// Render 대시보드 -> Environment -> DATABASE_URL 에 입력하는 것이 정석입니다.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '여기에_DB_주소를_넣으세요',
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// 테이블 생성 (영구 보관용)
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_data (
      id SERIAL PRIMARY KEY,
      product_id TEXT,
      product_name TEXT,
      revenue REAL,
      views INTEGER,
      sales INTEGER,
      date_str TEXT,
      month_str TEXT,
      UNIQUE(product_id, date_str)
    )
  `);
  console.log("✅ PostgreSQL 테이블 준비 완료");
};
initDB();

const upload = multer({ storage: multer.memoryStorage() });

// [API 1] 엑셀 업로드 및 저장 (UPSERT 로직)
app.post('/api/upload', upload.single('excelFile'), async (req, res) => {
  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    const dateStr = req.file.originalname.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0] || 'Unknown';
    const monthStr = dateStr.substring(0, 7);

    for (const item of data) {
      const pid = String(item['상품ID'] || item['상품번호'] || '');
      if (!pid) continue;
      
      await pool.query(`
        INSERT INTO sales_data (product_id, product_name, revenue, views, sales, date_str, month_str)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (product_id, date_str) 
        DO UPDATE SET product_name = $2, revenue = $3, views = $4, sales = $5
      `, [pid, item['상품명'], Number(item['결제금액']), Number(item['상품상세조회수']), Number(item['결제상품수량']), dateStr, monthStr]);
    }
    res.json({ message: '성공' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [API 2] 데이터 조회 (기존 로직 유지)
app.get('/api/data', async (req, res) => {
  const result = await pool.query("SELECT * FROM sales_data");
  // ... 이후 집계 로직은 기존과 동일하게 처리하여 JSON 반환 ...
  // (지면상 생략하지만 기존 server.js의 집계 로직을 그대로 붙여넣으시면 됩니다)
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 서버 가동 중: ${PORT}`));
