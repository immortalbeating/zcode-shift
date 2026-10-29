# Z·SHIFT

ZCode 多账号切换与额度查看工具。保留紧凑的桌面操作方式，统一账号、套餐和活动领取的显示与反馈。

由 [immortalbeating](https://github.com/immortalbeating/zcode-shift) 维护，采用 [MIT 许可证](LICENSE)。Z·SHIFT 与 ZCode 官方无隶属关系。

[English](README.en.md) · [来源与改动](NOTICE.md)

![Z·SHIFT 主界面，全部为合成演示账号](docs/screenshot.png)

## 主要功能

- 保存、重命名、导入、导出及切换 ZCode 登录身份。
- 按账号查看套餐、各模型剩余额度和重置时间。
- 手动或自动领取当前可领取活动；自动领取默认关闭，开启后定期检测。
- 已领取但尚未生效的活动显示赠送额度、生效时间和到期时间；可用余额按服务端实际返回显示。
- 界面支持中文与英文；托盘、开机自启、登录代理和 CLI 保留。
- 设置按常规、活动领取、账号切换、登录与网络、账号数据、高级、关于分组；低频选项按需展开。

## 这个版本的调整

- 使用 Z·SHIFT 名称、独立应用标记和窗口身份；账号头像、AGY 风格操作图标、深灰暖金配色、绿色额度与紧凑间距参考同一工作区的 AGY·SWITCH。
- 合并套餐预览和营销弹窗中的明确领取动作，按套餐去重；不会根据活动名称或日期写白名单。
- 修复验证码配置请求、领取结果关联和活动冷却；需要交互验证码时保留人工处理入口。
- 活动检测间隔可选 2 / 5 / 10 分钟，默认 5 分钟；每次最多同时查询两个账号，领取和官方验证依次进行。移除空账号和轮次结束时的固定等待，只在连续领取之间保留短间隔。
- 领取前复用同一账号、凭据及设备身份下 10 秒内的预览；提交后立即失效。查询与提交失败按错误类型退避，并遵守服务端返回的冷却时间。
- 主窗口显示检测、验证、提交阶段和下次检测倒计时；设置保留最近 30 条领取结果及查询、提交耗时。历史只在本机保存，不包含登录凭据。
- 设置支持路径自动查找、手动路径校验与恢复自动；路径和代理草稿在切换语言或开关时保留。代理可测试端口可达性，关于页可查询本仓库的 GitHub 正式版本。
- README 截图与界面测试仅使用合成数据。

## Windows 使用

从本仓库的 Releases 获取已发布版本；源代码不包含本机账号、凭据或实际领取报告。当前本地构建已在 Windows 验证，其他平台的构建状态以 CI 为准。

为兼容已有安装，账号库与设置继续使用 `~/.zcode-switch/`；ZCode 自身数据仍在 `~/.zcode/`。改名不会移动或重建这些目录。不要同时运行多个工具对同一账号执行切换或领取。

登录与额度查询使用官方服务。活动资格刷新可能向官方发送客户端激活事件；验证码由官方 SDK 处理。登录代理仅应用于工具内的登录窗口。独立的「ZCode 服务代理」控制活动检测、激活、领取、验证配置和 ZCode 余额查询，两个开关共用已保存的代理地址，服务代理支持 HTTP 地址且默认关闭。

同一账号的活动资格可能随请求出口而变化：登录时使用代理、活动检测却直连，可能查不到该账号实际可领的活动。遇到此情况可在「登录与网络」开启 ZCode 服务代理，使活动检测与领取使用同一出口。代理连接失败会报告错误，不会自动回退直连；BigModel 监控和 GitHub 更新不受该开关影响。

自动领取的实际耗时仍取决于网络、官方资格接口和验证码。端口测试只表示代理端口可达，不表示海外出口或授权登录一定可用。检查更新不会下载或安装软件；仓库尚无正式 Release 时会明确提示。

## 开发

需要 Node.js 20.19+ 或 22.12+、Rust stable，以及系统对应的 Tauri 2 构建依赖。

```sh
npm ci
npm run tauri dev
npm run check:syntax
npm run check:i18n
npm run test:claim
npm run build
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

`npm run dist` 生成 Windows 安装包和便携版，产物位于 `release/`。`app-icon.svg` 是图标源文件；执行 `node scripts/generate-icons.mjs` 生成平台图标。

## 界面验证

```sh
npx playwright install chromium
npm run test:ui
```

Windows 上默认使用系统 Edge 的独立临时配置；其他平台使用 Playwright Chromium。脚本注入合成 IPC，不读取账号文件，不操作系统光标或请求桌面焦点。截图保留 GPU 渲染，结果记录实际渲染后端；不支持的 GPU 环境会明确失败。结果保存在忽略提交的 `.ui-artifacts/`。

## CLI

```sh
zcode-shift.exe --cli state
zcode-shift.exe --cli quota --id <account-id>
zcode-shift.exe --cli claim-preview --id <account-id>
zcode-shift.exe --background
zcode-shift.exe --claim-once --id <account-id> --plan-id <plan-id>
```

`--claim-once` 会实际领取指定账号当前可领取的指定套餐。它使用独立 WebView2 配置和隐藏的无焦点窗口运行官方无感验证，输出 JSON 后退出；需要交互时返回 `interactive`，不会操作桌面输入，也不会改变全账号自动领取开关。

原有 CLI 其余命令继续保留：`list`、`capture`、`switch`、`rename`、`delete`、`update`、`behavior`、`setpath`、`launch`、`kill`、`export`、`export-all`、`import`。保留 `ZCODE_SWITCH_HOME` 环境变量兼容原来的隔离测试配置。

## 许可证

[MIT](LICENSE)。保留上游版权通知和 Git 提交历史；本仓库新增贡献也按 MIT 发布。请参阅 [NOTICE.md](NOTICE.md)。
