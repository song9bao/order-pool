# 集单池 - 部署指南

## 项目结构

```
order-pool/
├── app.js              # Koa 应用入口
├── nest.yml            # Nest Serverless 配置（备用）
├── manifest.yaml       # Plus/Hulk 部署配置
├── Dockerfile          # 容器构建文件
├── package.json        # 依赖配置
├── .nestignore         # Nest 部署忽略文件
├── .dockerignore       # Docker 构建忽略文件
└── public/
    └── index.html      # 前端页面
```

---

## 推荐方案：Plus + Hulk 容器化部署

> 这是最适合你当前环境的方案，不依赖 Nest CLI（不支持 Windows），只需要把代码推到 Git 仓库，然后在 Web 界面操作即可。

### 第一步：申请 AppKey

1. 打开 Avatar：https://avatar.mws.sankuai.com/#/service/mine
2. 点击「新建服务」
3. 填写：
   - 服务名称：`order-pool`
   - 服务类型：Node.js
   - 负责人：填你自己的 mis
4. 提交后获得 AppKey（如 `com.sankuai.xxx.orderpool`）

### 第二步：创建 Git 代码仓库

1. 打开 Code 平台：https://dev.sankuai.com/code
2. 创建新仓库，名称如 `order-pool`
3. 在本地初始化 Git 并推送代码：

```bash
cd D:\desk\order-pool
git init
git add .
git commit -m "初始化集单池项目"
git remote add origin ssh://git@git.sankuai.com/你的空间/order-pool.git
git push -u origin master
```

### 第三步：配置 Plus 发布项

1. 打开 DevTools：https://dev.sankuai.com/services
2. 找到你的 AppKey 对应的服务
3. 进入「发布项配置」
4. 设置：
   - 代码仓库：选择上面创建的仓库
   - 构建模板：选择 `prod`（或 `test` 先测试）
   - 描述文件：`manifest.yaml`（项目根目录）

### 第四步：触发构建部署

1. 在 DevTools 发布页面，选择分支（master）
2. 点击「构建」，等待构建完成
3. 构建成功后点击「部署」
4. 选择部署到测试环境或生产环境

### 第五步：配置域名（Oceanus）

部署成功后需要配置流量入口：

1. 打开 Oceanus：https://oceanus.sankuai.com
2. 创建站点，关联你的 AppKey
3. 配置路由规则，绑定内网域名
4. 配置完成后，通过内网域名即可访问集单池

---

## 备用方案：Nest Serverless

如果后续有 Mac/Linux 环境可用，也可以用 Nest 部署：

```bash
# Mac/Linux 环境下安装 Nest CLI
npm --registry=http://r.npm.sankuai.com install @mtfe/nest-cli -g

# 登录
nest login -n 你的mis

# 初始化关联（在项目目录下）
nest init -a 你的appkey

# 部署
nest deploy
```

---

## 本地开发

```bash
# 安装依赖
npm install

# 启动服务
npm start

# 访问
http://localhost:3000
```

---

## 功能说明

- 上传：支持 .xlsx/.xls 格式，自动检测重复 SKU
- 查询：按城市群、门店、一二三级品类、SKU 筛选
- 导出：一键导出当日全部集单数据
- 撤回：仅可撤回自己上传的数据
- 一键清空：清除集单池全部数据（需二次确认）
- 自动清零：每日 23:59 自动清空数据
