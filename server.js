const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');

const app = express();

/**
 * 1. PostgreSQL 데이터베이스 연결 설정
 * 복사한 URI 주소에서 [YOUR-PASSWORD]를 실제 비번으로 꼭 바꾸세요!
 */
const pool = new Pool({
  // 예: 'postgres://postgres.abcde:my-password-123@db.abcde.supabase.co:5432/postgres'
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:gpffhdnzoavld12@db.yobiwljswthbcfayisew.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

/**
 * 2. 데이터베이스 테이블 초기화
 */
const initDB = async () => {
  try {
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
    console.log("✅ PostgreSQL 테이블 준비 완료 (Supabase 연결됨)");
  } catch (err) {
    console.error("❌ DB 초기화 실패 (비밀번호나 주소를 확인하세요):", err);
  }
};
initDB();

const upload = multer({ storage: multer.memoryStorage() });

// ... 나머지 API 코드는 동일합니다 ...

app.post('/api/upload', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
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

app.get('/api/data', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sales_data ORDER BY date_str ASC");
    // (기존 집계 로직 실행 후 JSON 반환)
    // ... 생략 ...
    res.json({ /* 집계된 데이터 */ });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 서버 가동 중: ${PORT}`));
