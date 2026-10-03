# CRS 安全运维（2026-10-03）

本机部署基线为 1.1.324 / `ba68d1b1`，本次安全补丁在现有 checkout 原地交付。
当前补丁提交用 `git rev-parse HEAD` 查询。`config/config.js` 是本地忽略文件；新增代理策略字段与
`config/config.example.js` 同步，升级时必须保留。既有 `docs/OPERATIONS.md` 是用户未跟踪文件，
本次未修改或提交。

## HTTPS 与客户端迁移

- API：`https://111.229.114.217/api`
- 管理页：`https://111.229.114.217/admin-next/login`
- 健康检查：`https://111.229.114.217/health`
- 证书是 Let's Encrypt 签发的 IP SAN 证书，通过系统 CA 校验，无需跳过验证或安装自签证书。

用户最终选择：**本轮只迁移管理端，Claude Code 模型 API 的传输加密后置**。
现有 `http://111.229.114.217:3000/api`、CRS Key 与 Windows 客户端配置保留；
服务器本人的 Claude Code 配置也保持原 HTTP 地址，不更换官方计费 API Key。
公网 3000 和相应 UFW/安全组规则保留，监听仍为 `0.0.0.0:3000`，不能把本次交付称为全链路加密。
这项由用户后置，不是本次待确认事项。以后迁移模型 API 时再改客户端 URL、收口监听和防火墙。

管理页在 HTTPS 地址重新登录，账号和密码不变。页面、JS 与 CSS 使用 HTTPS，生产 SPA 的
API prefix 为空，登录请求实际发到同源 `/web/auth/login`，后台接口也保持同源 HTTPS。
不需要修改或构建前端。管理员凭据位置为私有 `data/init.json`，文档不记原值。

`CRS_ADMIN_HTTPS_ONLY=true`、`CRS_PUBLIC_HTTPS_URL=https://111.229.114.217` 在部署环境启用。
`managementHttps` 是 Express 的第一个中间件，先于任何静态处理、body parser、请求日志和认证。
HTTP 的 `/admin-next` 页面（GET/HEAD）及根页面只跳转到配置的固定 HTTPS origin；
`/admin`、`/web`、`/users`、`/apiStats`、`/metrics` 的明文请求直接 403，不跳转认证/后台 API。
保护路径的大小写、挂载边界与请求方法有测试。

HTTPS 反代仅由 socket 的 loopback 来源加精确 `X-Forwarded-Proto: https` 识别，
不采用公网传来的 `req.ip`、Host、Forwarded 或代理 IP 头。nginx 明确覆盖协议/IP 转发头；
外部伪造转发头已实测 403。loopback 上的本机进程处于可信服务器边界，不能把这一机制描述为
对恶意本机管理员的隔离。管理页面跳转只帮助打开正确入口；秘密如果已发送到旧 HTTP 仍然是明文，
后台拒绝不会追溯加密。旧模型 API 保持原认证链与路径，并已用无秘密请求验证 HTTP 401。
80 继续保留旅行站和 ACME challenge，其他路径 404。

## 短期 IP 证书维护

使用独立 Certbot 5.8 venv `/opt/crs-certbot/venv`，采用 `shortlived` profile、HTTP-01/webroot。
公开证书目录 `/etc/crs-letsencrypt/live/crs-ip/`，私钥及 ACME 账户数据仅 root 可读。
测试 CA 使用独立 `/etc/crs-letsencrypt-staging`，测试证书从未部署给 nginx。
nginx 配置 `/etc/nginx/sites-available/crs-https`，挑战目录 `/var/www/crs-acme`；
现有旅行站仅增加 challenge location，未停止共享 nginx。

IP 证书有效 160 小时。`crs-ip-renew.timer` 每四小时检查一次，随机延迟最多 15 分钟，
`Persistent=true`；`crs-ip-renew.service` 调用新 Certbot 的独立配置目录，
deploy hook `/usr/local/libexec/crs-certificate-deploy` 先 `nginx -t` 再 reload。
服务还检查证书剩余有效期至少 24 小时；失败会体现在 systemd 状态/journal 中，不向外发送通知。
系统原有 Certbot 2.9 timer 的默认配置目录与此分开，不负责 CRS IP 证书。

```bash
systemctl list-timers crs-ip-renew.timer
systemctl status crs-ip-renew.service
systemctl start crs-ip-renew.service
HTTPS_PROXY=http://127.0.0.1:7890 /opt/crs-certbot/venv/bin/certbot renew \
  --cert-name crs-ip --config-dir /etc/crs-letsencrypt \
  --work-dir /var/lib/crs-letsencrypt --logs-dir /var/log/crs-letsencrypt \
  --dry-run --run-deploy-hooks --no-random-sleep-on-renew \
  --deploy-hook /usr/local/libexec/crs-certificate-deploy
```

本次已经通过 staging 初次签发、正式签发、实际 HTTP-01 模拟续期及 deploy hook。
注册采用无邮箱选项，配置没有私人邮箱。80 和 443 的公网可达性已通过 CA 验证及外部代理实测。
CA 故障、共享代理故障、80 被封或主机长时间停机仍可能导致续期失败，不能取消日常有效期检查。

官方依据：[IP 证书一般开放](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/)、
[Certbot webroot/IP 支持](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。

## 固定节点、解析与出站限制

- CRS 专用 HTTP/SOCKS 入口 `127.0.0.1:17894`，固定到已有账号原来实际使用的新加坡 10。
- 预期公网 IPv4 为 `188.253.120.106`，安装前和专用入口两处无凭据探测结果一致。
- 专用 Mihomo 只有一个 SS 节点和 `MATCH,CRS_FIXED`，没有选择组、备用节点或 DIRECT 规则。
- 节点接入域名仅在安装时由宿主解析一次，随后固定数值 IPv4/端口。
- 应用 SOCKS 使用 `socks5h`，域名交给代理端；HTTP 使用 CONNECT。
  专用 DNS 只使用 `https://8.8.8.8/dns-query#CRS_FIXED`，禁用系统 hosts/IPv6/fallback；
  DNS 监听 `127.0.0.1:17896` 仅用于维护验证，CRS 不能访问该 DNS 端口。
- 独立 UID `crs` 的新连接只能到 `127.0.0.1:6379` 和 `127.0.0.1:17894`；
  独立 UID `crs-proxy` 只能到固定 SS 接入 IPv4/端口及自身验证入口。
  IPv4、IPv6、TCP/UDP DNS、共享 7890、R3 入口和子进程都受同一 nft 规则限制。
- `crs-egress-network.service` 在 CRS/专用代理前安装持久规则；独立 nft 表为 `inet crs_security`。
  只操作这个表，禁止清空全局规则、UFW 或 `claude_r3` 表。
- CRS 为非 root、无 capabilities、禁止提权；私有配置及宿主 DNS/D-Bus 辅助接口在服务挂载空间中不可见。
  Redis 保持原服务、原数据库与原凭据，未迁移账号身份或轮换 OAuth token。

`CRS_PROXY_REQUIRED=true` 在本机启用全局必需策略，显式端点列表限制为专用入口。
Claude OAuth 交换、cookie 授权、自动刷新、usage/profile、Console、后台测试和流式/非流式模型转发
在代码中要求代理。缺失字段、解析失败、不支持类型、端口无效、端点不在列表或 Agent 构造失败
均抛出 `PROXY_POLICY_REJECTED`，不返回 `null` 后继续直连。代理服务停止/上游不可达原本会报错；
本次修补的是配置/构造失败的直连回退风险，不声称曾观测到实际凭据泄漏。
GitHub 定价下载也显式使用专用维护代理。未使用本代理工具的外联仍受进程防火墙约束。

私有运行文件 `/var/lib/crs-egress/config.yaml`、`guard.json` 含节点接入配置；不得打印、提交或复制到报告。
`scripts/crs-security-network.py` 可从共享订阅中提取指定节点并生成独立部署，不修改共享配置选点。
账号只修改 Redis 中的 `proxy` 字段；本次四个账号旧值单独保存在私有回滚目录。
原有 Claude 账号的 `blocked` 状态保留，未通过真实模型调用证明 Max 额度可用。

### 公网 IP 边界与故障恢复

供应商没有提供固定公网 IP 保证。本次实现固定节点、固定接入 IPv4/端口和预期出口检测，
不能等同于购买了固定 IP。`crs-egress.service` 在通知 READY 前用两个 HTTPS 探测服务验证 IP；
运行中每轮等待 20 秒，再做每个最多 8 秒的两次检查。失败、超时、格式异常或 IP 漂移时，
关闭整个代理进程及既有连接，`Restart=no`，不自动修改期望值或换节点。
供应商在两次检查之间换出口仍有窗口；周期、探测超时及终止等待决定窗口上限，无法事前消除。
若必须保证每条请求绝无漂移，需要供应商侧固定 IP 产品/保证，这仍未具备。

```bash
systemctl status crs-egress crs-egress-network claude-relay
curl --noproxy '' --proxy socks5h://127.0.0.1:17894 https://api.ipify.org
curl --noproxy '' --proxy http://127.0.0.1:17894 https://checkip.amazonaws.com
```

故障时先停止 CRS，查看专用代理状态、节点订阅及固定接入是否变化。人工确认原节点的预期出口
后再更新私有配置/精确防火墙规则并做无凭据验收，然后启动 `crs-egress` 和 CRS。
不要直接修改共享 7890 的选点，不借用 R3 的 `10.207.3.1:17893`，不要自动把账号切到其他节点。
重装 helper 会重新解析接入地址；事前保存私有配置和账号路由快照，并先检查新配置/规则再应用。
[Mihomo DNS 指定代理的官方说明](https://wiki.metacubex.one/en/config/dns/)。

CRS 通过 `BindsTo`/`After` 绑定专用代理；代理未验证就绪时不启动 CRS，代理停止或失败也会停止 CRS。
恢复时先人工启动并验证 `crs-egress`，再启动 CRS，避免代理验证阶段承载账号请求。

## 日志和凭据

`logRedactor` 位于主日志、控制台、安全日志、认证状态日志、刷新日志及调试 dump 公共写入边界。
它递归处理对象、数组、Error、循环引用和 splat 参数，并处理序列化预览、Bearer/Basic、
常见 token/API Key 形态及带秘密字段的文本。敏感值整体替换，不保留 token 首尾片段。
OAuth 响应只记录 token 存在性、scope、有效期/状态，错误仍保留状态码、诊断文本和脱敏 stack。
日志脱敏无法识别无任何标签/已知形态的任意秘密；不要将原始凭据或恢复短语拼进自由文本。

`.env` 仅 root 可读，由 systemd 注入；`data/init.json` 为服务 UID 私有 0600，凭据值不进文档。
日志目录 0700，文件 0600，新建文件/服务 UMask 均限制为 0077；备份目录仅 root 可访问。
历史盘点 37 个文件，12 个含凭据形态内容。原件有受限归档及 SHA-256 清单，活动历史日志已可回退脱敏，
同一规则复扫匹配文件数为 0。这个结果不证明所有历史秘密都能用形态扫描识别。
未不可逆删除历史记录，未盲目轮换账号 token。运维 README 的管理员密码已替换为私有文件路径索引。
未经授权不要从受限归档恢复明文日志到活动日志目录。

## 验证与部署

本次使用合成凭据验证缺失/非法代理、Agent 构造异常、嵌套/错误/预览日志脱敏及真实日志传输。
必要 lint、Jest 全套及 Python guard 测试通过；网络验收包含正常出口、端口关闭、合成上游不可达、
UID/子进程 IPv4/IPv6、TCP/UDP DNS 与共享代理旁路阻断。端口关闭测试发生在账号迁入之前，
合成故障代理独立启动，未停止共享代理或在已有 R3 会话中注入故障。
真实证书校验、未认证接口、Redis/CRS 健康、原旅行站和其他服务/R3 的未变状态均已检查。
未请求真实模型，未读取 R3 凭据、刷新 R3 token 或改变其隔离服务。

```bash
npm run lint:check
NODE_OPTIONS=--max-old-space-size=2560 npm test -- --runInBand
PYTHONDONTWRITEBYTECODE=1 python3 tests/crsEgressGuard.test.py
curl --noproxy '*' --fail https://111.229.114.217/health
redis-cli ping
```

## 回滚

私有回滚目录 `/var/backups/crs-security-20261003-154614` 保存原服务、环境、nginx 静态站、
本地客户端配置、原运维文档、Git 基线源文件、账号旧代理字段及两轮历史日志备份。
`account-proxy-routing.json` 只包含旧路由；`log-manifest.json` 可核对原件完整性。
这些文件及原文档可能含真实秘密，仅在受限环境解析，不要整份输出。

回滚顺序：停止 CRS；按本次提交的明确路径恢复基线代码和本地配置、原服务/drop-in，
只恢复各账号 `proxy` 字段，不覆盖整库；保留已签发 HTTPS 和 nginx challenge/续期设施。
即便回退应用代码，也用独立环境覆盖 `HOST=127.0.0.1`，防止重新开放明文公网。
若确需撤销专用网络，先停止专用代理并确认无 `crs` 进程，再删除本次 drop-in、
停用 `crs-egress`/`crs-egress-network`，仅删除 `inet crs_security` 表。
不要恢复明文日志，不要清空 Redis、移除共享/R3 规则或用 `git reset --hard` 覆盖用户变更。
恢复代理配置会失去本轮固定出口保证，必须重新做健康与外联验收后再对用户开放。
