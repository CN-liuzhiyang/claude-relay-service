# CRS 安全部署与运维

本文是可复用的部署说明，不记录任何生产实例。`192.0.2.10`、`203.0.113.10` 和
`2001:db8::1` 是保留文档地址，不能直接用于生产部署；节点、目录及版本参数须由维护者填写。
真实管理地址、预期出口、账号路由、验收结果和回滚位置只保存在 Git 外的私有运维记录中。
不要把生产配置、凭据、原始日志或私有记录复制到公开仓库。

`config/config.js` 是本地忽略文件。部署时将 `config/config.example.js` 的安全/代理字段同步到
本地配置，并在升级中保留环境变量支持。用 `git rev-parse HEAD` 和 `VERSION` 记录实际部署版本。

## HTTPS 管理入口

先部署可信 TLS 反代，验证证书和管理登录，再启用：

```dotenv
CRS_ADMIN_HTTPS_ONLY=true
CRS_PUBLIC_HTTPS_URL=https://192.0.2.10
```

管理页地址为 `<management-origin>/admin-next/login`，健康检查为 `<management-origin>/health`。
前端的登录及后台 API 应使用同源 HTTPS，例如 `/web/auth/login`；检查实际构建产物的 API prefix，
不要让 HTTPS 页面仍向 HTTP 后台发送凭据。管理员凭据只保存在受限的 `data/init.json` 中。

`managementHttps` 位于静态处理、body parser、请求日志和认证之前。启用策略后，HTTP 根页面及
`/admin-next` 的 GET/HEAD 请求跳转至配置的 HTTPS origin；`/admin`、`/web`、`/users`、
`/apiStats`、`/metrics` 的明文请求直接返回 403，携带凭据的请求不会被重定向。
页面跳转不能保护已经发送到 HTTP 的秘密。

反代使用 loopback 连接 CRS，覆盖 `X-Forwarded-Proto` 为 `https`，并覆盖客户端提供的转发 IP 头。
应用仅信任 TLS socket，或 socket 对端为 loopback 且协议头精确为 `https` 的请求；不信任公网提供的
Host、Forwarded、`req.ip` 或协议头。本机 loopback 进程仍处于可信服务器边界，应限制本机运行身份。

该策略可兼容现有 HTTP 模型 API，保留原地址、路径和认证链。若选择暂留 HTTP 模型 API，
其 API Key 和请求内容仍以明文传输，不能宣称全链路加密。模型客户端迁移与公网端口收口需要另行安排：
先验证 HTTPS API、更新所有客户端 URL，再限制应用监听地址和防火墙；不要只靠 HTTP 重定向迁移秘密。

### IP 证书与续期

仅有公网 IP 时，可使用支持 IP SAN 的公开 CA 证书。Let's Encrypt 的 IP 证书使用 `shortlived`
profile 和 HTTP-01 或 TLS-ALPN-01；Certbot webroot IP 支持需要 5.4 或更新版本。
签发前按官方文档核对客户端支持，并确认验证端口公网可达。

在现有 HTTP 站点中增加 `/.well-known/acme-challenge/` 的 webroot location，保留原站点。
先用独立 staging 配置目录验证，再正式签发；staging 证书不得给生产客户端使用。
下面的地址仅是示例，执行时替换成可验证的公网 IP：

```bash
certbot certonly --webroot --webroot-path /var/www/crs-acme \
  --preferred-profile shortlived --ip-address 192.0.2.10 \
  --cert-name crs-ip --agree-tos --register-unsafely-without-email
```

nginx 手动加载证书和私钥，反代到 `127.0.0.1:3000`。部署前 `nginx -t`，通过后 reload；
证书必须通过系统 CA 及目标 IP/域名校验，不得使用跳过校验或不受信任的自签证书代替。
证书、ACME 账户及私钥使用受限目录，并与其他站点的续期配置分开管理。

短期 IP 证书有效期为 160 小时，应设置专用 systemd 续期 timer，例如每四小时运行一次、
最多随机延迟十五分钟并启用 `Persistent=true`。续期服务使用对应的 config/work/log 目录，
deploy hook 先验证 nginx 配置再 reload；增加至少 24 小时剩余有效期检查。
签发、`renew --dry-run --run-deploy-hooks`、hook 和 timer 均应实际验证。
CA、代理或验证端口故障及长时间停机仍可能造成失效，需要维护者检查失败状态和证书有效期。

官方说明：[IP 证书一般开放](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/)、
[Certbot webroot/IP 支持](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。

## 专用出口、远端解析与出站限制

`scripts/crs-security-network.py` 是 root 部署辅助脚本，需要 Mihomo、PyYAML、nftables、ACL 工具及
现有的 systemd 应用服务。它从 `/etc/mihomo/config.yaml` 提取明确指定的 Shadowsocks 节点，
生成独立配置，不修改共享代理选点。运行前查看脚本、端口、服务路径及现有防火墙，保存私有回滚备份。
不要把凭据放在命令行参数中。

```bash
python3 scripts/crs-security-network.py \
  --node '<node-name>' \
  --expected-ip 203.0.113.10 \
  --management-origin https://192.0.2.10 \
  --private-path /srv/private/operations
```

`--management-origin` 必填，只接受不含凭据、路径、查询或片段的 HTTPS origin，并写入
`CRS_PUBLIC_HTTPS_URL`。`--private-path` 可重复指定需要在应用服务中隐藏的其他私有目录，
使用不含空白或转义字符的绝对路径。默认隐藏 checkout 所有者的私有配置目录及宿主 DNS/D-Bus 辅助接口。
脚本会写入服务配置并启用网络规则，不会替维护者迁移账号代理或完成 HTTPS 签发。

- 专用 HTTP/SOCKS 入口为 `127.0.0.1:17894`，DNS 监听为 `127.0.0.1:17896`。
- 配置只包含一个指定节点和 `MATCH,CRS_FIXED`，没有自动选点、备用节点或 DIRECT。
- 节点接入域名只在安装时由宿主解析，随后固定数值 IPv4 和端口。
- SOCKS 使用 `socks5h` 远端解析，HTTP 使用 CONNECT；目标域名 DoH 为
  `https://8.8.8.8/dns-query#CRS_FIXED`，不使用系统 hosts、IPv6 或 DNS fallback。
- 应用 UID `crs` 的新连接只允许到本机 Redis 和专用代理；UID `crs-proxy` 只允许到固定接入端点及
  自身验证入口。其他 IPv4/IPv6、TCP/UDP DNS、共享代理及子进程旁路由同一 UID 规则拒绝。
- `crs-egress-network.service` 管理独立 nft 表 `inet crs_security`；只操作该表，不清空全局防火墙。
- 应用服务使用独立 UID、空 capabilities、禁止提权、受限写目录和私有配置访问限制。

生成的运行配置保存在 `/etc/crs-security` 和 `/var/lib/crs-egress`，仅相应服务身份或 root 可读。
这些是通用服务目录；实际节点接入、出口和凭据不得进入版本控制或公开报告。
先验证网络配置及专用代理就绪，再按账号逐项修改 Redis 中的 `proxy` 字段，保留原路由快照，
不覆盖账号身份、状态或整个数据库，也不自动切换到无关节点。

部署环境启用 `CRS_PROXY_REQUIRED=true`，并将 `CRS_PROXY_ALLOWED_ENDPOINTS` 限制为专用入口。
`CRS_MAINTENANCE_PROXY` 为维护下载提供同一代理。Claude OAuth、刷新、usage/profile、后台测试及
模型流式/非流式路径要求代理；配置缺失、非法类型、无效端口、不允许的端点或 Agent 构造失败时，
抛出 `PROXY_POLICY_REJECTED`。代理服务故障原本就会报错，修复的是配置/构造失败后直连回退的风险。
不使用代理工具的进程外联仍受 UID 防火墙限制。

### 出口漂移与恢复

固定端口、节点及接入 IP 不等于供应商保证固定公网 IP。`crs-egress.service` 的 guard 在 READY 前
通过两个 HTTPS 探测服务检查预期出口；运行时每轮等待二十秒，再执行两次各最多八秒的探测。
探测失败、超时、格式异常或出口漂移会关闭代理及既有连接；`Restart=no`，不自动换节点或更新预期 IP。
周期探测存在两次检查之间的漂移窗口。若要求每条请求都绝无出口漂移，需要供应商侧固定 IP 保证。

应用通过 `BindsTo`/`After` 绑定专用代理。恢复前停止应用，核对节点订阅、接入端点和出口，
人工更新受限配置及对应防火墙规则，用无凭据探测验证后先启动专用代理，再启动应用。
重跑安装脚本会重新解析节点接入地址；事前备份并检查新规则，不能通过切换共享代理规避故障。

```bash
systemctl status crs-egress crs-egress-network claude-relay
curl --noproxy '' --proxy socks5h://127.0.0.1:17894 https://api.ipify.org
curl --noproxy '' --proxy http://127.0.0.1:17894 https://checkip.amazonaws.com
```

真实探测结果仅写入私有运维记录。
[Mihomo DNS 指定代理说明](https://wiki.metacubex.one/en/config/dns/)。

## 日志、凭据与历史记录

`logRedactor` 位于日志公共写入边界，递归处理对象、数组、Error、循环引用、splat、序列化预览、
Bearer/Basic、常见 token/API Key 和带秘密字段的文本。敏感值整体替换，不保留首尾片段。
OAuth 认证详情只记录凭据存在性、scope、有效期和状态；错误保留状态码及脱敏诊断/stack。
无标签且没有可识别形态的任意秘密仍可能无法识别，不要把原始凭据拼进自由文本。

`.env` 仅 root 可读并由 systemd 注入；`data/init.json` 为服务 UID 私有的 0600 文件。
日志目录为 0700，文件为 0600，服务 UMask 为 0077；备份目录仅授权运维身份可访问。
先盘点历史日志/备份，仅输出匹配类别、位置、文件数量和权限，避免显示值。
将原件保存到 Git 外的受限归档，生成完整性清单，再对活动历史日志脱敏并复扫。
归档支持回退，但不得未经授权把明文恢复到活动日志目录。形态扫描为零不等于没有任意历史秘密。

私有 SOP 只引用凭据文件位置，不记真实值。发布前检查仓库可见性、staged diff 和必要凭据匹配，
测试只使用保留文档地址、`.example`/`.invalid` 域名及合成凭据。普通清理提交只改变最新版本，
已公开的旧提交仍可检索；历史处理和凭据轮换须依据单独授权与实际发现。

## 验收与回滚

```bash
npm run lint:check
NODE_OPTIONS=--max-old-space-size=2560 npm test -- --runInBand
PYTHONDONTWRITEBYTECODE=1 python3 tests/crsEgressGuard.test.py
PYTHONDONTWRITEBYTECODE=1 python3 tests/crsSecurityNetwork.test.py
redis-cli ping
```

验收覆盖缺失/无效代理、Agent 构造失败、嵌套/错误/预览日志脱敏和实际日志传输。
网络验证覆盖专用出口、端口关闭、合成上游不可达及 UID/子进程 IPv4/IPv6/DNS/其他代理旁路。
故障测试在独立环境或账号迁入前执行，不停止共享代理，也不向在线账号注入故障。
验证可信证书、管理登录与后台请求、外部伪造协议头拒绝、旧 HTTP 模型 API 的认证响应及 Redis 健康；
使用合成凭据和未认证请求，避免真实模型消费。部署前后核对其他服务和隔离环境的状态。

回滚备份放在 Git 外的 `<private-backup-dir>`，记录对应代码版本、配置、服务定义、nginx、
账号旧代理字段及历史日志完整性清单。备份可能包含真实秘密，不整份输出或提交。

回滚时先停止应用，恢复明确的代码路径和本地配置/服务定义，仅恢复账号 `proxy` 字段。
保留可用 HTTPS、challenge 和续期设施；若回退代码不支持管理 HTTPS 限制，先限制应用监听或增加
等效反代/防火墙保护，避免重新公开明文管理端。撤销专用网络前停止代理并确认无应用 UID 进程，
停用对应服务后只移除 `inet crs_security`。不清空 Redis，不恢复明文日志，不覆盖无关用户改动。
恢复后重新验证健康、认证边界、出口策略及其他服务，再对客户端开放。
