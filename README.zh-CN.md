<p align="center"><img src="docs/assets/tallymark.png" alt="" width="86" height="86"></p>

<h1 align="center">Tallymark · 刻记</h1>

<p align="center">MCP 服务的执行安全测试工具</p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

**客户端重试一次，后端到底写了几笔？** 两次 MCP 调用都返回成功，同一笔业务也可能被提交两次。Tallymark（原项目名 MCP Reliability Kit）按配置模拟重试或超时，用独立的后端记录核对实际提交次数，再把判定和证据交给 CI。

[Beta 候选版 `0.4.0-beta.2`](docs/beta-validation.md) · Node.js 22.12+ · [MIT 许可证](LICENSE)

## 看一次真实判定

业务规则很简单：同一笔操作只能产生一张收据。实验使用 Python MCP 服务 Backburner 执行任务，把收据写入 SQLite。三组测试都模拟了首次回复丢失，都使用同一条业务规则。

| 场景                               | 工具调用次数 | 收据数（判定时 → 任务全部结束后） | 判定                                                                                  |
| ---------------------------------- | -----------: | --------------------------------- | ------------------------------------------------------------------------------------- |
| 每次提交都插入一张收据             |            2 | 2 → 2                             | [**FAIL**](integrations/evidence/2026-11-22/backburner/duplicate/database.json)       |
| 数据库用唯一操作键对两个任务去重   |            2 | 1 → 1                             | [**PASS**](integrations/evidence/2026-11-22/backburner/deduplicated/database.json)    |
| 首个任务仍在运行，测试工具暂缓重试 |            1 | 0 → 1                             | [**INCONCLUSIVE**](integrations/evidence/2026-11-22/backburner/delayed/database.json) |

点击判定可以查看数据库原始记录。第三组的收据是在 CLI 退出后才写入的。另一组 HTTP 取消实验也记录到了类似情况：Python 请求处理程序已经收到取消信号，此前入队的任务仍在客户端进程退出后完成了提交。[Backburner 实验](docs/backburner.md) · [客户端、服务端和 SQLite 取消记录](docs/http-cancellation.md)

## 快速开始

在源码目录使用 Node.js 22.12+ 和 pnpm 9.15.0。下面的命令会启动内置测试服务，业务记录写入独立的临时账本。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm kit doctor
mkdir -p artifacts/demo
pnpm kit init -c artifacts/demo/safe.yaml
pnpm kit test -c artifacts/demo/safe.yaml --out artifacts/demo/reports
```

`doctor` 会发现内置服务提供的工具，工具调用次数为零。最后一条命令运行四个验证用例，全部通过时退出码为 0，并打印 JSON 和 JUnit 报告路径。要观察能触发失败的对照组，可以用新的文件名再运行一次 `init`，并加上 `--fixture unsafe`。

也可以直接离线查看一次真实失败。下面的命令返回退出码 1。两次追加写入都返回成功，独立读取文件时找到了两个标记，而用例只允许一个。[原始报告](integrations/evidence/2026-11-22/filesystem-append/report.json)

```sh
pnpm kit report integrations/evidence/2026-11-22/filesystem-append/report.json
```

```text
FAIL         repeat-append  calls=2 effects=2
  append_file · duplicate · verified · severity high
  2 committed effects observed for one logical operation. The declared maximum is 1.
```

<details>
<summary>在其他项目中安装 Beta 候选包</summary>

在源码目录运行 `pnpm test:package --npm`。这条命令会构建安装包，并在全新的 npm 项目中验证它。安装包和对应的 SHA-256 校验文件位于 `artifacts/pack`。进入要接入的项目，把下面的路径换成本机安装包的实际路径。

```sh
npm install --save-dev /path/to/mcp-reliability-kit-0.4.0-beta.2.tgz
npx --no-install mcp-reliability-kit doctor
```

npm 包名和命令名都是 `mcp-reliability-kit`。当前可通过本地候选包试用，公开发布仍在准备中。[发布清单](docs/release-checklist.md)

</details>

## 接入自己的服务

先发现运行中的 Streamable HTTP 服务提供了哪些工具，再从结果中选一个来生成配置。下面以 `read_counter` 为例。

```sh
pnpm kit doctor --url http://localhost:3000/mcp
pnpm kit init --url http://localhost:3000/mcp --tool read_counter -c observe.yaml
pnpm kit test -c observe.yaml
```

生成的用例默认禁用。第一次测试会得到 `SKIPPED`，退出码为 3，工具调用次数为零。检查参数，确认允许调用后把 `allowSideEffects` 设为 `true`。下面的命令授权向这个地址发起一次工具调用。

```sh
pnpm kit test -c observe.yaml --allow-external --allow-url http://localhost:3000/mcp
```

`doctor` 会列出协商的协议版本、工具名、服务端声明的只读提示，以及工具是否要求以任务方式运行。加上 `--json` 可获取结构化输出。发现远程 HTTPS 服务还需用 `--allow-url` 指定同一地址。观察模式下，即使回复符合预期，执行安全性仍为 `INCONCLUSIVE`。

<details>
<summary>接入本地 stdio 服务</summary>

使用 `--allow-stdio` 前，先检查可执行程序及其参数。SDK 协商期间可能启动两次进程。下面使用锁定版本的 Filesystem 参考服务，请在源码目录用 Node.js 24+ 运行。

```sh
npm ci --prefix integrations/reference --ignore-scripts --no-audit --no-fund
export PATH="$PWD/integrations/reference/node_modules/.bin:$PATH"
pnpm kit doctor --stdio-config examples/stdio-target.json --allow-stdio
pnpm kit init --example filesystem -c filesystem.yaml
```

</details>

## 编写可验证的业务约束

观察模式记录回复和超时，回复与预期不一致就可能判定失败。要验证业务结果，还需要从后端独立获取两类证据：实际已提交多少次，以及哪些调用尝试已经结束。只要观察到提交次数超过上限，就能判定 `FAIL`。要得到 `PASS`，还必须确认回复符合预期、每次重试前的检查通过，而且所有尝试都已结束。

```yaml
version: 1
targets:
  ledger: { kind: fixture, mode: safe }
tests:
  - id: lost-reply
    target: ledger
    mode: verified
    tool: record_payment
    arguments: { operationKey: '{{operationKey}}', cents: 1250 }
    allowSideEffects: true
    fault: { kind: lost-response, maxRetries: 1 }
    expectResponses: [lost, success]
    verify: { kind: fixture }
    invariant: { minEffects: 1, maxEffects: 1 }
```

接入自己的服务时，把同一笔业务的操作键和每次尝试各自的 ID 一直传递到实际提交的事务或后台任务。配置 `verify: {kind: file, path: ledger.json}`，由独立导出程序原子写入完整快照。可用 `maxAgeMs` 限制快照允许的最大年龄。如果只能观察回复，使用 `mode: observational` 和 `verify: {kind: none}`。[约束与导出格式](docs/contract-spec.md) · [故障排查](docs/troubleshooting.md)

## CI 与中断恢复

随项目提供的 GitHub Actions 模板会保留退出码、生成任务摘要并上传 JSON 和 JUnit 报告。模板默认测试内置服务。接入自己的应用时，请使用已检查的用例和独立的测试环境。[GitHub Actions 模板](examples/ci/verified.yml) · [配置指南](docs/ci.md)

| 退出码 | 测试套件的判定                                                            |
| -----: | ------------------------------------------------------------------------- |
|      0 | 全部用例都有证据表明其满足约束。                                          |
|      1 | 至少一个用例有证据表明其违反约束。                                        |
|      2 | 配置、基础设施、清理或报告发生错误。优先于退出码 1。                      |
|      3 | 存在 `INCONCLUSIVE` 或 `SKIPPED`，且没有 `FAIL` 或 `ERROR`。CI 不予放行。 |

用 `report "$REPORT_JSON"` 可以离线查看报告，每项结果都附有单独复现该用例的命令。运行意外中断时，使用启动时打印在标准错误流中的路径，执行 `mcp-reliability-kit journal "$PROGRESS_JSON"`。有效的未完成日志返回退出码 3。再次运行前，先到实际提交数据的后端核对日志中列出的尝试 ID。[架构](docs/architecture.md) · [证据的适用范围](docs/limitations.md)

## 项目状态

本地 Beta 验证覆盖 macOS 和 Debian arm64，并接入了 Filesystem、Memory、Git 和 Backburner。托管 CI 验证及 npm 公开发布仍在准备中。[验证结果与耗时](docs/beta-validation.md) · [兼容性](docs/compatibility.md)

MCP Rig 支持在传输层丢弃回复、重试和调用验证工具。Tallymark 的回复丢失场景发生在应用层：SDK 已解码回复，测试工具模拟调用方没有收到它。其内置流程会用独立业务账本核对重试结果，并把尚无定论的情况明确传递给 CI。[与 MCP Rig、Inspector 等工具的比较](docs/competitive-analysis.md)

[参与贡献](CONTRIBUTING.md) · [安全问题报告](SECURITY.md) · [更新记录](CHANGELOG.md) · [许可证](LICENSE)
