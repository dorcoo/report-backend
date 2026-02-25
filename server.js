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
  // 정상 작동 확인된 5432 포트 주소입니다.
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres.yobiwljswthbcfayisew:WHD147.,.ww@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

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
        month_str TEXT
      )
    `);
    // 1. 기존에 잘못 걸려있던 제약조건(ID+날짜 기준)을 삭제합니다.
    await pool.query(`ALTER TABLE sales_data DROP CONSTRAINT IF EXISTS sales_data_product_id_date_str_key`).catch(() => {});
    // 2. 새로운 제약조건(ID+상품명+날짜 기준)을 추가합니다.
    await pool.query(`ALTER TABLE sales_data ADD CONSTRAINT unique_pid_name_date UNIQUE(product_id, product_name, date_str)`).catch(() => {});

    console.log("✅ PostgreSQL 테이블 준비 완료");
  } catch (err) {
    console.error("❌ DB 초기화 실패:", err);
  }
};
initDB();

const upload = multer({ storage: multer.memoryStorage() });

/**
 * [API 1] 엑셀 업로드 (1차 엑셀 내부 중복 제거 + 2차 DB 덮어쓰기)
 */
app.post('/api/upload', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    
    const dateStr = req.file.originalname.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0] || 'Unknown';
    const monthStr = dateStr !== 'Unknown' ? dateStr.substring(0, 7) : 'Unknown';

    console.log(`[업로드 시작] ${req.file.originalname} 처리 중...`);

    // 🔥 [1차 중복 제거] 상품ID와 '상품명'이 모두 똑같을 때만 합칩니다.
    const uniqueDataMap = new Map();

    for (const item of data) {
      const pid = String(item['상품ID'] || item['상품번호'] || '');
      if (!pid) continue;

      const name = item['상품명'] || '이름 없음';
      const revenue = Number(item['결제금액']) || 0;
      const views = Number(item['상품상세조회수']) || 0;
      const sales = Number(item['결제상품수량']) || 0;

      // ID와 이름을 결합한 고유 키 생성 (이름이 다르면 합쳐지지 않음)
      const uniqueKey = `${pid}_${name}`;

      if (uniqueDataMap.has(uniqueKey)) {
        // 완벽히 일치하는 경우에만 합산
        const existing = uniqueDataMap.get(uniqueKey);
        existing.revenue += revenue;
        existing.views += views;
        existing.sales += sales;
      } else {
        uniqueDataMap.set(uniqueKey, { pid, name, revenue, views, sales });
      }
    }

    const uniqueData = Array.from(uniqueDataMap.values());
    if (uniqueData.length === 0) return res.status(400).json({ error: '유효한 데이터가 없습니다.' });

    const values = [];
    const flatParams = [];
    let paramIndex = 1;

    for (const item of uniqueData) {
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      flatParams.push(item.pid, item.name, item.revenue, item.views, item.sales, dateStr, monthStr);
    }

    // 🔥 [2차 중복 제거] DB 덮어쓰기 기준에 '상품명'을 추가합니다.
    const query = `
      INSERT INTO sales_data (product_id, product_name, revenue, views, sales, date_str, month_str)
      VALUES ${values.join(', ')}
      ON CONFLICT (product_id, product_name, date_str) 
      DO UPDATE SET 
        revenue = EXCLUDED.revenue, 
        views = EXCLUDED.views, 
        sales = EXCLUDED.sales
    `;

    await pool.query(query, flatParams);
    console.log(`✅ [업로드 완료] 총 ${uniqueData.length}개 상품 (중복 압축됨) 저장 성공`);

    res.json({ message: '성공적으로 저장되었습니다.', count: uniqueData.length });
  } catch (e) {
    console.error("❌ 업로드 에러:", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * [API 2] 대시보드 통계 데이터 조회
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
