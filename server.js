const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();

// 1. 보안 및 데이터 용량 제한 설정 (대용량 엑셀 대응)
app.use(cors({
  origin: '*', // 모든 도메인 허용 (테스트용으로 가장 확실함)
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// 2. 데이터베이스 연결 및 초기화
// 클라우드 배포 시에도 경로가 유지되도록 정대경로 설정을 권장합니다.
const dbPath = path.resolve(__dirname, 'sales_pro.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ DB 연결 실패:', err);
  else console.log('✅ SQLite 데이터베이스 연결 완료:', dbPath);
});

// 테이블 구조 및 인덱스 생성 (성능 최적화)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sales_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  db.run(`CREATE INDEX IF NOT EXISTS idx_product ON sales_data(product_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_date ON sales_data(date_str)`);
});

// 3. 파일 업로드 설정
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 최대 100MB 허용
});

const extractDate = (fileName) => {
  const matches = fileName.match(/\d{4}-\d{1,2}-\d{1,2}/g);
  if (!matches) return '알 수 없는 날짜';
  return matches.map(m => {
    const parts = m.split('-');
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }).sort().pop();
};

// [API 1] 엑셀 업로드 및 스마트 저장
app.post('/api/upload', upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const dateStr = extractDate(fileName);
    const monthStr = dateStr !== '알 수 없는 날짜' ? dateStr.substring(0, 7) : '알 수 없는 월';

    console.log(`[작업 시작] ${fileName} (${dateStr}) 데이터 처리 중...`);

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO sales_data 
        (product_id, product_name, revenue, views, sales, date_str, month_str) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      let count = 0;
      data.forEach(item => {
        const pid = String(item['상품ID'] || item['상품번호'] || '');
        if (!pid) return;
        const name = item['상품명'] || '이름 없음';
        const revenue = Number(item['결제금액']) || 0;
        const views = Number(item['상품상세조회수']) || 0;
        const sales = Number(item['결제상품수량']) || 0;

        stmt.run(pid, name, revenue, views, sales, dateStr, monthStr);
        count++;
      });
      
      stmt.finalize();
      db.run("COMMIT", (err) => {
        if (err) {
          console.error("❌ DB 저장 오류:", err);
          return res.status(500).json({ error: '저장 실패' });
        }
        console.log(`✅ [완료] ${count}건의 데이터 동기화 완료.`);
        res.json({ message: '성공적으로 배포되었습니다.', count });
      });
    });

  } catch (error) {
    console.error("❌ 서버 에러:", error);
    res.status(500).json({ error: '서버 내부 처리 에러' });
  }
});

// [API 2] 대시보드 통계 연산
app.get('/api/data', (req, res) => {
  db.all("SELECT * FROM sales_data", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const productMap = new Map();
    const dailyMap = new Map();
    const monthlyMap = new Map();
    const productDailyHistory = new Map();
    let currentMaxDate = '';

    rows.forEach(row => {
      const { product_id: pid, product_name: name, revenue, views, sales, date_str, month_str } = row;
      if (date_str !== '알 수 없는 날짜' && date_str > currentMaxDate) currentMaxDate = date_str;

      if (!dailyMap.has(date_str)) dailyMap.set(date_str, { date: date_str, 매출: 0, 조회수: 0, 판매량: 0 });
      if (!monthlyMap.has(month_str)) monthlyMap.set(month_str, { month: month_str, 매출: 0, 조회수: 0, 판매량: 0 });
      
      dailyMap.get(date_str).매출 += revenue; dailyMap.get(date_str).조회수 += views; dailyMap.get(date_str).판매량 += sales;
      monthlyMap.get(month_str).매출 += revenue; monthlyMap.get(month_str).조회수 += views; monthlyMap.get(month_str).판매량 += sales;

      if (!productMap.has(pid)) {
        productMap.set(pid, { 
          상품ID: pid, lastName: name, 결제금액: revenue, 상품상세조회수: views, 결제상품수량: sales, 
          nameHistory: [{ name: name, start: date_str, end: date_str }], nameCount: 1 
        });
      } else {
        const p = productMap.get(pid);
        p.결제금액 += revenue; p.상품상세조회수 += views; p.결제상품수량 += sales;
        let nr = p.nameHistory.find(nh => nh.name === name);
        if (!nr) { 
          p.nameHistory.push({ name: name, start: date_str, end: date_str }); 
          p.nameCount = p.nameHistory.length; p.lastName = name; 
        } else {
          if (date_str < nr.start) nr.start = date_str;
          if (date_str > nr.end) nr.end = date_str;
        }
      }

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
        const days = Math.ceil(Math.abs(new Date(nh.end) - new Date(nh.start)) / (1000 * 60 * 60 * 24)) + 1;
        return { 
          name: nh.name, totalRevenue: tRev, totalSales: tSales, totalViews: tViews, 
          dailyAvgViews: tViews / days, dailyAvgRevenue: tRev / days,
          cvr: tViews > 0 ? (tSales / tViews) * 100 : 0, days, periodStart: nh.start, periodEnd: nh.end 
        };
      }).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
      return { ...p, 상세조회대비결제율: p.상품상세조회수 > 0 ? p.결제상품수량 / p.상품상세조회수 : 0, history, performanceByName };
    });

    res.json({
      processedData: finalProducts,
      dailyTrend: finalDailyTrend,
      monthlyTrend: finalMonthlyTrend,
      globalMaxDate: currentMaxDate
    });
  });
});

// [API 3] DB 데이터 초기화
app.delete('/api/clear', (req, res) => {
  db.run("DELETE FROM sales_data", (err) => {
    if (err) return res.status(500).json({ error: '데이터 삭제 실패' });
    console.log(`[초기화] 모든 데이터 삭제됨.`);
    res.json({ message: '성공적으로 초기화되었습니다.' });
  });
});

// 🔥 클라우드 서비스(Render 등)는 process.env.PORT를 통해 포트를 할당받습니다.
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ 서버 대기 중: 포트 ${PORT}`);

});
