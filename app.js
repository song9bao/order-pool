const Koa = require('koa');
const Router = require('koa-router');
const serve = require('koa-static');
const { koaBody } = require('koa-body');
const XLSX = require('xlsx');
const cron = require('node-cron');
const path = require('path');

const app = new Koa();
const router = new Router();
const PORT = process.env.PORT || 3000;

// 数据存储（内存，每日清零）
// dataPool 紧凑格式：每行为 [城市群, 门店/仓编码, 商品SKU, 核查量, uploadId]
const COL_CITY = 0, COL_STORE = 1, COL_SKU = 2, COL_QTY = 3, COL_UPLOAD_ID = 4;
let dataPool = [];       // 所有上传的行数据（紧凑数组）
let uploadRecords = [];  // 上传记录 {id, uploader, fileName, uploadTime, rowCount}
let lastActiveDate = new Date().toISOString().slice(0, 10); // 记录当前日期

// 跨日检查：每次有请求进来时检测是否跨日，若跨日则自动清零
function checkDayRollover() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastActiveDate) {
    console.log(`[${new Date().toLocaleString('zh-CN')}] 检测到跨日(${lastActiveDate} -> ${today})，自动清零`);
    dataPool = [];
    uploadRecords = [];
    lastActiveDate = today;
  }
}

// 静态文件服务
app.use(serve(path.join(__dirname, 'public')));

// 解析请求体（含文件上传）
app.use(koaBody({
  multipart: true,
  formidable: {
    maxFileSize: 50 * 1024 * 1024, // 50MB
    keepExtensions: true
  }
}));

// 跨日检查中间件
app.use(async (ctx, next) => {
  checkDayRollover();
  await next();
});

// 上传接口
router.post('/api/upload', async (ctx) => {
  try {
    const uploader = ctx.request.body.uploader || '未知用户';
    const file = ctx.request.files && ctx.request.files.file;

    if (!file) {
      ctx.status = 400;
      ctx.body = { success: false, message: '请选择文件' };
      return;
    }

    // 检查文件格式
    const ext = path.extname(file.originalFilename || '').toLowerCase();
    if (!['.xlsx', '.xls'].includes(ext)) {
      ctx.status = 400;
      ctx.body = { success: false, message: '仅支持 .xlsx 或 .xls 格式' };
      return;
    }

    const workbook = XLSX.readFile(file.filepath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      ctx.status = 400;
      ctx.body = { success: false, message: '文件中没有数据' };
      return;
    }

    // 构建已有SKU索引（O(1)查找）
    const existingSkuMap = new Map();
    for (let i = 0; i < dataPool.length; i++) {
      const sku = dataPool[i][COL_SKU];
      if (sku) existingSkuMap.set(sku, dataPool[i][COL_UPLOAD_ID]);
    }

    // 检查重复SKU
    const duplicates = [];
    rows.forEach((row, idx) => {
      const sku = String(row['商品SKU'] || '').trim();
      if (!sku) return;
      const existingUploadId = existingSkuMap.get(sku);
      if (existingUploadId) {
        const rec = uploadRecords.find(r => r.id === existingUploadId);
        duplicates.push({
          sku,
          rowIndex: idx + 2,
          existingUploader: rec ? rec.uploader : '未知',
          existingUploadTime: rec ? rec.uploadTime : '',
          productName: row['商品名称'] || ''
        });
      }
    });

    if (duplicates.length > 0) {
      ctx.body = {
        success: false,
        message: '发现重复SKU',
        duplicates: duplicates.map(d => ({
          sku: d.sku,
          rowIndex: d.rowIndex,
          productName: d.productName,
          conflictWith: d.existingUploader,
          conflictTime: d.existingUploadTime
        }))
      };
      return;
    }

    // 写入数据池（紧凑存储，只保留必要字段）
    const uploadId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const uploadTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    // 每行存为 [城市群, 门店/仓编码, 商品SKU, 核查量, uploadId]
    // uploader 和 uploadTime 存在 uploadRecords 里，通过 uploadId 关联，避免每行重复存储
    const compactRows = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      compactRows[i] = [
        String(row['城市群'] || '').trim(),
        row['门店/仓编码'] != null ? row['门店/仓编码'] : '',
        row['商品SKU'] != null ? String(row['商品SKU']) : '',
        Number(row['核查量']) || 0,
        uploadId
      ];
    }

    // 用 concat 代替 push(...) 避免大数组栈溢出
    dataPool = dataPool.concat(compactRows);
    uploadRecords.push({
      id: uploadId,
      uploader,
      fileName: file.originalFilename,
      uploadTime,
      rowCount: rows.length
    });

    ctx.body = {
      success: true,
      message: `上传成功！共 ${rows.length} 条数据`,
      uploadId,
      rowCount: rows.length
    };
  } catch (err) {
    ctx.status = 500;
    ctx.body = { success: false, message: '上传处理失败: ' + err.message };
  }
});

// 获取所有城市群列表（用于前端复选框）
router.get('/api/cities', async (ctx) => {
  const citySet = new Set();
  for (let i = 0; i < dataPool.length; i++) {
    const city = dataPool[i][COL_CITY];
    if (city) citySet.add(city);
  }
  ctx.body = { success: true, cities: [...citySet].sort() };
});

// 查询接口（按门店分组汇总，支持城市群多选筛选）
router.get('/api/query', async (ctx) => {
  const { store, cities } = ctx.query;
  const cityList = cities ? cities.split(',').map(c => c.trim()).filter(Boolean) : [];
  const citySet = cityList.length > 0 ? new Set(cityList) : null;

  // 构建 uploadId -> record 的快速索引
  const recMap = new Map();
  uploadRecords.forEach(r => recMap.set(r.id, r));

  // 按门店/仓编码分组汇总
  const groupMap = {};
  for (let i = 0; i < dataPool.length; i++) {
    const row = dataPool[i];
    // 城市群筛选
    if (citySet && !citySet.has(row[COL_CITY])) continue;
    // 门店筛选
    const storeId = String(row[COL_STORE]);
    if (store && !storeId.includes(store)) continue;

    const key = storeId.trim();
    if (!groupMap[key]) {
      const rec = recMap.get(row[COL_UPLOAD_ID]);
      groupMap[key] = { storeId: key, city: row[COL_CITY], skuCount: 0, totalQty: 0, uploader: rec ? rec.uploader : '', uploadTime: rec ? rec.uploadTime : '' };
    }
    groupMap[key].skuCount += 1;
    groupMap[key].totalQty += row[COL_QTY];
  }

  const grouped = Object.values(groupMap);

  ctx.body = {
    success: true,
    total: grouped.length,
    data: grouped
  };
});

// 统计概览接口
router.get('/api/stats', async (ctx) => {
  ctx.body = {
    success: true,
    totalRows: dataPool.length,
    totalUploads: uploadRecords.length,
    records: uploadRecords
  };
});

// 导出接口（支持按城市群筛选，支持 format=csv）
router.get('/api/export', async (ctx) => {
  const { cities, format } = ctx.query;
  const cityList = cities ? cities.split(',').map(c => c.trim()).filter(Boolean) : [];
  const citySet = cityList.length > 0 ? new Set(cityList) : null;

  // 筛选数据（不复制整个数组，用索引记录）
  let filtered;
  if (citySet) {
    filtered = [];
    for (let i = 0; i < dataPool.length; i++) {
      if (citySet.has(dataPool[i][COL_CITY])) filtered.push(dataPool[i]);
    }
  } else {
    filtered = dataPool;
  }

  if (filtered.length === 0) {
    ctx.status = 400;
    ctx.body = { success: false, message: '当前筛选条件下没有数据可导出' };
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    // CSV 格式导出（文件更小，下载更快）
    const BOM = '\uFEFF';
    const lines = new Array(filtered.length + 1);
    lines[0] = '城市群,门店/仓编码,商品SKU,核查量';
    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      lines[i + 1] = `${String(r[COL_CITY]).replace(/,/g, '，')},${r[COL_STORE]},${r[COL_SKU]},${r[COL_QTY]}`;
    }

    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('集单池_' + today + '.csv')}`);
    ctx.body = BOM + lines.join('\n');
  } else {
    // XLSX 格式导出
    const exportData = new Array(filtered.length);
    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      exportData[i] = { '城市群': r[COL_CITY], '门店/仓编码': r[COL_STORE], '商品SKU': r[COL_SKU], '核查量': r[COL_QTY] };
    }

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '集单池数据');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });

    ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('集单池_' + today + '.xlsx')}`);
    ctx.body = Buffer.from(buf);
  }
});

// 撤回接口（只能撤回自己上传的）
router.post('/api/revoke', async (ctx) => {
  const { uploadId, uploader } = ctx.request.body;
  if (!uploadId || !uploader) {
    ctx.status = 400;
    ctx.body = { success: false, message: '缺少参数' };
    return;
  }

  const record = uploadRecords.find(r => r.id === uploadId);
  if (!record) {
    ctx.status = 404;
    ctx.body = { success: false, message: '未找到该上传记录' };
    return;
  }
  if (record.uploader !== uploader) {
    ctx.status = 403;
    ctx.body = { success: false, message: '只能撤回自己上传的数据' };
    return;
  }

  // 移除数据
  dataPool = dataPool.filter(d => d[COL_UPLOAD_ID] !== uploadId);
  uploadRecords = uploadRecords.filter(r => r.id !== uploadId);

  ctx.body = { success: true, message: '撤回成功' };
});

// 手动清零接口（管理用）
router.post('/api/clear', async (ctx) => {
  dataPool = [];
  uploadRecords = [];
  ctx.body = { success: true, message: '已手动清零' };
});

// 每日 23:59 清零
cron.schedule('59 23 * * *', () => {
  console.log(`[${new Date().toLocaleString('zh-CN')}] 集单池数据清零`);
  dataPool = [];
  uploadRecords = [];
}, { timezone: 'Asia/Shanghai' });

// 注册路由
app.use(router.routes());
app.use(router.allowedMethods());

// 启动服务
app.listen(PORT, () => {
  console.log(`集单池服务启动: http://localhost:${PORT}`);
});

module.exports = app;
