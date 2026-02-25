const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');

const app = express();

/**
 * 1. PostgreSQL 데이터베이스 연결 설정
 */
const pool = new Pool({
  // 포트번호를 5432로 복구하고, 에러가 났던 끝부분 쉼표(,)를 추가했습니다.
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres.yobiwljswthbcfayisew:WHD147.,.ww@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres',
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
    console.error("❌ DB 초기화 실패:", err);
  }
};
initDB();

const upload = multer({ storage: multer.memoryStorage() });

/**
 * [핵심 개선] API 1: 엑셀 업로드 및 초고속 일괄 저장 (Bulk Upsert)
 * 기존의 for문을 돌며 하나씩 INSERT 하던 방식을 버리고,
 * 수천 개의 데이터를 단 하나의 쿼리로 묶어서 1초 만에 DB에 밀어넣습니다.
 */
app.post('/api/upload', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    
    // 1. 엑셀 파일 해독
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    
    // 파일 이름에서 날짜 추출 (예: 2024-02-25_data.xlsx -> 2024-02-25)
    const dateStr = req.file.originalname.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0] || 'Unknown';
    const monthStr = dateStr !== 'Unknown' ? dateStr.substring(0, 7) : 'Unknown';

    console.log(`[업로드 시작] ${req.file.originalname} (데이터 ${data.length}줄) 처리 중...`);

    // 2. 일괄 삽입(Bulk Insert)을 위한 데이터 배열 만들기
    const values = [];
    const flatParams = [];
    let paramIndex = 1;

    for (const item of data) {
      const pid = String(item['상품ID'] || item['상품번호'] || '');
      if (!pid) continue;

      const name = item['상품명'] || '이름 없음';
      const revenue = Number(item['결제금액']) || 0;
      const views = Number(item['상품상세조회수']) || 0;
      const sales = Number(item['결제상품수량']) || 0;

      // PostgreSQL 다중 INSERT 문법에 맞게 ($1, $2, $3...) 괄호 묶음 생성
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      flatParams.push(pid, name, revenue, views, sales, dateStr, monthStr);
    }

    if (values.length === 0) {
      return res.status(400).json({ error: '저장할 유효한 데이터가 엑셀에 없습니다. (상품ID 누락 등)' });
    }

    // 3. 단 하나의 거대한 쿼리 조립 및 실행 (1초 컷)
    const query = `
      INSERT INTO sales_data (product_id, product_name, revenue, views, sales, date_str, month_str)
      VALUES ${values.join(', ')}
      ON CONFLICT (product_id, date_str) 
      DO UPDATE SET 
        product_name = EXCLUDED.product_name, 
        revenue = EXCLUDED.revenue, 
        views = EXCLUDED.views, 
        sales = EXCLUDED.sales
    `;

    await pool.query(query, flatParams);
    console.log(`✅ [업로드 완료] ${values.length}개 데이터 초고속 저장 성공`);

    res.json({ message: '성공적으로 저장되었습니다.', count: values.length });
  } catch (e) {
    console.error("❌ 업로드 에러:", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * [API 2] 대시보드 통계 데이터 조회 (기존과 동일)
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

      if (!dailyMap.has(date_str)) dailyMap.set(date_str, { date: date_str, 매출: 0, 조회수: 0, 판매량: 0 });
      if (!monthlyMap.has(month_str)) monthlyMap.set(month_str, { month: month_str, 매출: 0, 조회수: 0, 판매량: 0 });
      
      dailyMap.get(date_str).매출 += revenue;
      dailyMap.get(date_str).조회수 += views;
      dailyMap.get(date_str).판매량 += sales;
      monthlyMap.get(month_str).매출 += revenue;
      monthlyMap.get(month_str).조회수 += views;
      monthlyMap.get(month_str).판매량 += sales;

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
      p.lastName = name;

      let nameEntry = p.nameHistory.find(nh => nh.name === name);
      if (!nameEntry) {
        p.nameHistory.push({ name: name, start: date_str, end: date_str });
      } else {
        if (date_str < nameEntry.start) nameEntry.start = date_str;
        if (date_str > nameEntry.end) nameEntry.end = date_str;
      }
      p.nameCount = p.nameHistory.length;

      if (!productDailyHistory.has(pid)) productDailyHistory.set(pid, []);
      productDailyHistory.get(pid).push({ date: date_str, 매출: revenue, 조회수: views, 판매량: sales, nameUsed: name });
    });

    const finalDailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const finalMonthlyTrend = Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month));
    
    const finalProducts = Array.from(productMap.values()).map(p => {
      const history = (productDailyHistory.get(p.상품ID) || []).sort((a, b) => a.date.localeCompare(b.date));
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clear', async (req, res) => {
  try {
    await pool.query("DELETE FROM sales_data");
    res.json({ message: '초기화 완료' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 서버 가동 중: ${PORT}`));
