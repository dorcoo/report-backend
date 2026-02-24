const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');

const app = express();

/**
 * 1. PostgreSQL 데이터베이스 연결 설정
 * Supabase 또는 외부 PostgreSQL 서비스에서 제공하는 연결 주소를 사용합니다.
 */
const pool = new Pool({
  // Render 대시보드의 Environment 설정에 DATABASE_URL을 추가하는 것이 가장 안전합니다.
  connectionString: process.env.DATABASE_URL || '여기에_실제_DB_주소를_넣으세요',
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

/**
 * 2. 데이터베이스 테이블 초기화 (영구 보관용)
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
    console.log("✅ PostgreSQL 테이블 준비 완료");
  } catch (err) {
    console.error("❌ DB 초기화 실패:", err);
  }
};
initDB();

const upload = multer({ storage: multer.memoryStorage() });

/**
 * [API 1] 엑셀 업로드 및 스마트 저장 (중복 자동 업데이트 - UPSERT)
 */
app.post('/api/upload', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    
    // 파일명에서 날짜 추출 (YYYY-MM-DD)
    const dateStr = req.file.originalname.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0] || 'Unknown';
    const monthStr = dateStr.substring(0, 7);

    console.log(`[업로드 작업] ${req.file.originalname} 처리 중...`);

    // 효율적인 저장을 위해 트랜잭션 대신 순차 처리 (작은 데이터셋용)
    for (const item of data) {
      const pid = String(item['상품ID'] || item['상품번호'] || '');
      if (!pid) continue;

      const name = item['상품명'] || '이름 없음';
      const revenue = Number(item['결제금액']) || 0;
      const views = Number(item['상품상세조회수']) || 0;
      const sales = Number(item['결제상품수량']) || 0;

      /**
       * ON CONFLICT: 같은 상품ID와 날짜 데이터가 이미 있으면 덮어씌우고(UPDATE), 없으면 삽입(INSERT)합니다.
       */
      await pool.query(`
        INSERT INTO sales_data (product_id, product_name, revenue, views, sales, date_str, month_str)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (product_id, date_str) 
        DO UPDATE SET product_name = $2, revenue = $3, views = $4, sales = $5
      `, [pid, name, revenue, views, sales, dateStr, monthStr]);
    }

    console.log(`✅ ${data.length}건 데이터 처리 완료`);
    res.json({ message: '성공적으로 저장되었습니다.', count: data.length });
  } catch (e) {
    console.error("❌ 업로드 에러:", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * [API 2] 대시보드 통계 데이터 조회 (전체 집계 로직 완벽 포함)
 */
app.get('/api/data', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sales_data ORDER BY date_str ASC");
    const rows = result.rows;

    const productMap = new Map();
    const dailyMap = new Map();
    const monthlyMap = new Map();
    const productDailyHistory = new Map();
    let currentMaxDate = '';

    rows.forEach(row => {
      const { product_id: pid, product_name: name, revenue, views, sales, date_str, month_str } = row;

      if (date_str !== 'Unknown' && date_str > currentMaxDate) currentMaxDate = date_str;

      // 1. 일별/월별 집계
      if (!dailyMap.has(date_str)) dailyMap.set(date_str, { date: date_str, 매출: 0, 조회수: 0, 판매량: 0 });
      if (!monthlyMap.has(month_str)) monthlyMap.set(month_str, { month: month_str, 매출: 0, 조회수: 0, 판매량: 0 });
      
      dailyMap.get(date_str).매출 += revenue;
      dailyMap.get(date_str).조회수 += views;
      dailyMap.get(date_str).판매량 += sales;
      
      monthlyMap.get(month_str).매출 += revenue;
      monthlyMap.get(month_str).조회수 += views;
      monthlyMap.get(month_str).판매량 += sales;

      // 2. 상품별 데이터 집계
      if (!productMap.has(pid)) {
        productMap.set(pid, { 
          상품ID: pid, lastName: name, 결제금액: 0, 상품상세조회수: 0, 결제상품수량: 0, 
          nameHistory: [], nameCount: 0 
        });
      }
      
      const p = productMap.get(pid);
      p.결제금액 += revenue;
      p.상품상세조회수 += views;
      p.결제상품수량 += sales;
      p.lastName = name; // 가장 최신 데이터의 이름으로 유지

      // 명칭 변경 이력 관리
      let nameEntry = p.nameHistory.find(nh => nh.name === name);
      if (!nameEntry) {
        p.nameHistory.push({ name: name, start: date_str, end: date_str });
      } else {
        if (date_str < nameEntry.start) nameEntry.start = date_str;
        if (date_str > nameEntry.end) nameEntry.end = date_str;
      }
      p.nameCount = p.nameHistory.length;

      // 3. 상품별 일일 기록 (그래프용)
      if (!productDailyHistory.has(pid)) productDailyHistory.set(pid, []);
      productDailyHistory.get(pid).push({ date: date_str, 매출: revenue, 조회수: views, 판매량: sales, nameUsed: name });
    });

    const finalDailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const finalMonthlyTrend = Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month));
    
    const finalProducts = Array.from(productMap.values()).map(p => {
      const history = (productDailyHistory.get(p.상품ID) || []).sort((a, b) => a.date.localeCompare(b.date));
      
      // 명칭별 성과 분석
      const performanceByName = p.nameHistory.map(nh => {
        const nameData = history.filter(h => h.nameUsed === nh.name);
        const tRev = nameData.reduce((s, h) => s + h.매출, 0);
        const tSales = nameData.reduce((s, h) => s + h.판매량, 0);
        const tViews = nameData.reduce((s, h) => s + h.조회수, 0);
        const days = nameData.length || 1;
        return { 
          name: nh.name, totalRevenue: tRev, totalSales: tSales, totalViews: tViews,
          dailyAvgRevenue: tRev / days,
          dailyAvgViews: tViews / days,
          cvr: tViews > 0 ? (tSales / tViews) * 100 : 0,
          periodStart: nh.start, periodEnd: nh.end
        };
      }).sort((a, b) => a.periodStart.localeCompare(b.periodStart));

      return { 
        ...p, 
        상세조회대비결제율: p.상품상세조회수 > 0 ? p.결제상품수량 / p.상품상세조회수 : 0, 
        history, 
        performanceByName 
      };
    });

    res.json({
      processedData: finalProducts,
      dailyTrend: finalDailyTrend,
      monthlyTrend: finalMonthlyTrend,
      globalMaxDate: currentMaxDate
    });
  } catch (err) {
    console.error("❌ 조회 에러:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * [API 3] DB 초기화
 */
app.delete('/api/clear', async (req, res) => {
  try {
    await pool.query("DELETE FROM sales_data");
    console.log("⚠️ 모든 데이터가 삭제되었습니다.");
    res.json({ message: '초기화 완료' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 서버 가동 중: 포트 ${PORT}`));
