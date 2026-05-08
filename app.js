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
let dataPool = [];       // 所有上传的行数据
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
    dataPool.forEach(d => {
      const sku = String(d['商品SKU'] || '').trim();
      if (sku) existingSkuMap.set(sku, d);
    });

    // 检查重复SKU
    const duplicates = [];
    rows.forEach((row, idx) => {
      const sku = String(row['商品SKU'] || '').trim();
      if (!sku) return;
      const existing = existingSkuMap.get(sku);
      if (existing) {
        duplicates.push({
          sku,
          rowIndex: idx + 2,
          existingUploader: existing._uploader,
          existingUploadTime: existing._uploadTime,
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

    // 写入数据池
    const uploadId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const uploadTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const enrichedRows = rows.map(row => ({
      ...row,
      _uploader: uploader,
      _uploadTime: uploadTime,
      _uploadId: uploadId
    }));

    // 用 concat 代替 push(...) 避免大数组栈溢出
    dataPool = dataPool.concat(enrichedRows);
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
  dataPool.forEach(r => {
    const city = String(r['城市群'] || '').trim();
    if (city) citySet.add(city);
  });
  ctx.body = { success: true, cities: [...citySet].sort() };
});

// 查询接口（按门店分组汇总，支持城市群多选筛选）
router.get('/api/query', async (ctx) => {
  const { store, cities } = ctx.query;
  let result = [...dataPool];

  // 城市群多选筛选（逗号分隔）
  if (cities) {
    const cityList = cities.split(',').map(c => c.trim()).filter(Boolean);
    if (cityList.length > 0) {
      result = result.filter(r => cityList.includes(String(r['城市群'] || '').trim()));
    }
  }
  if (store) result = result.filter(r => String(r['门店/仓编码'] || '').includes(store));

  // 按门店/仓编码分组汇总
  const groupMap = {};
  result.forEach(r => {
    const key = String(r['门店/仓编码'] || '').trim();
    if (!groupMap[key]) {
      groupMap[key] = { storeId: key, city: String(r['城市群'] || '').trim(), skuCount: 0, totalQty: 0, uploader: r._uploader, uploadTime: r._uploadTime };
    }
    groupMap[key].skuCount += 1;
    groupMap[key].totalQty += Number(r['核查量']) || 0;
    // 取最新的上传人和时间
    if (r._uploadTime > groupMap[key].uploadTime) {
      groupMap[key].uploader = r._uploader;
      groupMap[key].uploadTime = r._uploadTime;
    }
  });

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

// 导出接口（支持按城市群筛选导出）
router.get('/api/export', async (ctx) => {
  const { cities } = ctx.query;
  let result = [...dataPool];

  // 城市群多选筛选
  if (cities) {
    const cityList = cities.split(',').map(c => c.trim()).filter(Boolean);
    if (cityList.length > 0) {
      result = result.filter(r => cityList.includes(String(r['城市群'] || '').trim()));
    }
  }

  if (result.length === 0) {
    ctx.status = 400;
    ctx.body = { success: false, message: '当前筛选条件下没有数据可导出' };
    return;
  }

  const exportData = result.map(row => ({
    '城市群': row['城市群'] || '',
    '门店/仓编码': row['门店/仓编码'] || '',
    '商品SKU': row['商品SKU'] || '',
    '核查量': row['核查量'] || ''
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '集单池数据');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const today = new Date().toISOString().slice(0, 10);
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('集单池_' + today + '.xlsx')}`);
  ctx.body = Buffer.from(buf);
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
  dataPool = dataPool.filter(d => d._uploadId !== uploadId);
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
