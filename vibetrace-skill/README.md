# VibeTrace SWE-bench Experiment

`vibetrace` 是用于在 SWE-bench Verified 上验证 skill 在线自进化算法的实验工程。estimator、distiller、scorer 使用压缩后的 evidence digest 和 skill-pool digest 作为 LLM 输入；`online_schema.py` 仍保留 `trace.session.v1` 和 `pool_summary` 转换函数，用于结构化记录、复现实验和后续在线系统对接。skill 更新使用实验侧的 `PatchOp` 结构。

当前默认配置只使用 DeepSeek：

- 主任务模型：`relay/deepseek-v4-flash`
- estimator：`relay/deepseek-v4-flash`
- distiller/scorer：默认继承主任务模型

## Project Layout

```text
config/default.yaml
data/swe-bench-verified/split_subsystem_v1.json
prompts/
scripts/download_swebench_verified_repos.py
scripts/prefetch_crun_rootfs.py
src/
INTEGRATION.md
pyproject.toml
requirements.venv.lock
run_relay.sh
opencode.relay.jsonc
```

`prompts/` 保存所有 LLM prompt 模板。数据 parquet、克隆的基准仓库、rootfs
缓存、`results/`、`logs/` 和 `.relay_key` 都是本地运行产物，不属于源码交付。
`results/` 下直接保存 `results_*` 实验目录，不再使用中间 archive 层。

## Installation

```bash
cd vibetrace
python -m venv ../.venvs/vibetrace
source ../.venvs/vibetrace/bin/activate
pip install -U pip
pip install -r requirements.venv.lock
pip install -e .
```

还需要保证 `opencode` 在 `PATH` 中可执行。

`pip install -e .` 是当前推荐安装方式，因为运行时会从源码树读取
`config/default.yaml` 和 `prompts/*.md`。若要把它改造成普通 wheel 或嵌入其他
Python 服务，应将这两类资源纳入目标应用的资源管理；具体边界见
[在线系统集成指南](INTEGRATION.md)。

## Keys

在项目根目录创建 `.relay_key`：

```bash
export DEEPSEEK_API_KEYS='sk-1,sk-2,sk-3'
```

多个 key 会被 `src/llm.py` 和 `src/opencode_runner.py` 按 subprocess 轮换写入 `DEEPSEEK_API_KEY`。这能在并发实验中降低单 key 限流和排队延迟，但不会让单次 LLM 调用本身变快；如果 DeepSeek 对账号而不是 key 做统一限流，收益会下降。

## Data

将 SWE-bench Verified parquet 放到：

```text
data/swe-bench-verified/test-00000-of-00001.parquet
```

克隆或更新任务仓库：

```bash
python scripts/download_swebench_verified_repos.py
```

在运行实验前预拉取 seed 42/43/44 的 train/test crun rootfs 镜像：

```bash
python scripts/prefetch_crun_rootfs.py --workers 2
```

脚本会合并三个 seed 的任务并去重，跳过完整缓存，自动删除并重拉缺少
`rootfs/testbed` 的不完整缓存。只检查状态而不下载：

```bash
python scripts/prefetch_crun_rootfs.py --list-only
```

不要与正在运行的评测同时执行，以免两个进程操作同一 rootfs 目录。可用
`--seeds` 指定其他 seed，用 `--attempts` 设置每个镜像的完整重试次数，
用 `--workers` 控制同时预取的镜像数（默认 2，磁盘和代理余量充足时可设为 4）。

crun 下载器会把通过 digest 校验的压缩 layer 缓存在
`<rootfs_cache>/.blobs`，不同镜像共享相同 layer；未完成的 `.part` 文件会在
重试或重新运行脚本时通过 HTTP Range 续传。若需把压缩缓存放到其他磁盘，
可设置 `evaluator.crun.blob_cache`。完整 rootfs 和压缩 layer 会同时占用磁盘，
确认所有镜像均已预取且不再需要断点续传后，可以单独清理 `.blobs`。

默认 rootfs 缓存位于
`data/swe-bench-verified/crun-rootfs`。`evaluator.crun.proxy: null` 时读取环境
变量 `HTTPS_PROXY`；也可以在本地 YAML 覆盖中显式设置代理和缓存绝对路径。

默认使用 `data/swe-bench-verified/split_subsystem_v1.json` 做 train/test 划分，并只保留 `<15 min fix`、`15 min - 1 hour`、`1-4 hours` 三类难度。

## Run

推荐统一通过 wrapper 运行。它会加载虚拟环境、设置 `OPENCODE_CONFIG`、加载 `.relay_key`，并把终端输出写入 `logs/`。

主任务不会继承 wrapper 使用的 harness venv。默认情况下，每个 task workspace
都会在 `.opencode_state/<workspace>/python-env` 获得独立的临时 venv；`python`、
`pip` 和 `uv` 的安装只写入该任务环境，任务结束后随 OpenCode state 一起删除。
这避免并发任务的 editable install、`.pth` 和 site-packages 相互污染。默认允许
只读访问系统 site-packages 以减少重复安装；可通过
`opencode.python_env_system_site_packages: false` 获得完全空白的 venv。除调试外
不建议关闭 `opencode.isolate_python_env`。

查看 split：

```bash
bash run_relay.sh split
```

默认配置只运行 seed 42：

```bash
bash run_relay.sh run-all --concurrency 24 --repeats 3
```

多 seed 实验需要提供配置覆盖，例如 `config/multiseed.yaml`：

```yaml
run:
  seeds: [42, 43, 44]
```

```bash
bash run_relay.sh --config config/multiseed.yaml run-all \
  --concurrency 24 \
  --repeats 3
```

快速得到冻结 pool 的 `base` 与 `trace-only` 对比：

```bash
bash run_relay.sh run-all \
  --settings base trace-only \
  --concurrency 40 \
  --repeats 1
```

`run-all` 会依次完成一个模式的全部训练，冻结该模式的最终 pool，再立即完成该模式在 `D_test` 上的所有 repeats；测试轨迹不会更新 pool。正式多 seed 实验默认在 seed 间循环轮换模式顺序，以抵消固定墙钟先后顺序的影响；单 seed 的第一个顺序仍为 `base -> trace-only -> trace-fb`。

中断后指向同一个实验根目录恢复：

```bash
bash run_relay.sh run-all \
  --resume \
  --output-dir results/results_run_all_YYYYMMDD_HHMMSS \
  --concurrency 24 \
  --repeats 3
```

`train-base` 和 final eval 每完成一个任务 session 就原子更新 checkpoint；尚未执行完 verifier 的已保存 trace 会在恢复后统一重新评分。`trace-only`/`trace-fb` 每完成一个 prequential round 就保存当时的 pool、trace 和候选状态，因此恢复不会跳过或重复应用 pool update。恢复时会校验数据顺序、模型、repeats、settings 和冻结 skill-pool 哈希，不兼容时直接报错而不是混合实验。

`run-all` 对每个 seed 执行：

1. 在 `D_distill` 上跑无 skill 的 base train baseline，随后以空 pool 在 `D_test` 完成 base 的所有 repeats。
2. 在 `D_distill` 完成 `trace-only` 在线 distill，冻结最终 pool，随后在 `D_test` 完成 trace-only 的所有 repeats，并立即写出累计的 base vs trace-only 报告。
3. 对 `trace-fb` 重复同样的 train、冻结和 test 流程，最后写出三种模式的完整报告。

`D_test` 上的执行只读取对应的冻结 pool，不进入 estimator、distiller 或 scorer，也不会把测试轨迹写回 pool。

只跑某个阶段：

```bash
bash run_relay.sh train-base
bash run_relay.sh distill
bash run_relay.sh evaluate --repeats 3
bash run_relay.sh report
bash run_relay.sh inspect --setting trace-fb
```

跳过 wrapper 的清理：

```bash
SE_NO_CLEAN=1 bash run_relay.sh run-all --concurrency 24 --repeats 3
```

使用 docker harness 而不是 crun：

```bash
SE_EVAL_BACKEND=docker bash run_relay.sh evaluate --repeats 1
```

## Results

`run-all` 会创建：

```text
results/results_run_all_YYYYMMDD_HHMMSS/by_model/relay__deepseek-v4-flash/
```

核心文件：

```text
seed_42/distill/train_report_base.json
seed_42/distill/train_report_trace-only.json
seed_42/distill/train_report_trace-fb.json
seed_42/distill/skillpool_trace-only.json
seed_42/distill/skillpool_trace-fb.json
seed_42/distill/skills_md_trace-only/*.md
seed_42/distill/skills_md_trace-fb/*.md
seed_42/distill/rounds_trace-only.json
seed_42/distill/rounds_trace-fb.json
seed_42/distill/candidates_trace-only.json
seed_42/distill/candidates_trace-fb.json
seed_42/distill/traces_trace-only.json
seed_42/distill/traces_trace-fb.json
seed_42/distill/checkpoint_base.json
seed_42/distill/checkpoint_trace-only.json
seed_42/distill/checkpoint_trace-fb.json
seed_42/final/report.json
seed_42/final/combined_report.json
seed_42/final/checkpoint_base.json
seed_42/final/checkpoint_trace-only.json
seed_42/final/checkpoint_trace-fb.json
multiseed_report.json
```

直接用一次 `evaluate` 同时测试所有模式时，final checkpoint 使用兼容的 `checkpoint.json`。

每个主任务 session 完成时，日志会打印实际 `skill` tool action 中的技能名称，例如 `skills=running-project-tests`；没有调用 skill 时显示 `skills=(none)`。fork session 单独打印，不计入主任务 report。

## Metrics

所有 report 指标只统计解决 SWE-bench 当前原任务时返回的主 trace。fork 运行以及 estimator、distiller、scorer 的开销都不计入 report；这些指标不表示 skill 学习系统的端到端总开销。如果主运行在 runner 内部重试，当前只记录最终返回的 attempt，不累加之前失败 attempt 的开销。

主要指标：

- `pass_rate`: verifier resolved 比例。
- `avg_total_tokens`: `avg_in_tok_cached + avg_out_tok`。
- `avg_in_tok_cached`: 输入侧 token，等于 `input + cacheRead + cacheWrite`。
- `avg_cache_read_tokens`: 输入侧实际命中缓存的 `cacheRead` token。
- `avg_out_tok`: output token 与 reasoning token 之和。
- `avg_cost_usd`: 优先使用 opencode 事件中的 API cost；没有 API cost 时按 `pricing.in_hit`、`pricing.in_miss`、`pricing.out` 计算。
- `avg_time_sec`: 主 trace 中第一个与最后一个 OpenCode 事件的时间跨度，不包含 fork、grading 和辅助 LLM 调用。
- `avg_tool_calls`: opencode tool call 数。
- `avg_objective`: `pass_rate` 与 USD cost/time/tool-call 预算共同形成的 verifier objective。

在线系统 `VibeTrace` 的 trace bundle 中，token breakdown 使用：

```json
{
  "input": 0,
  "output": 0,
  "reasoning": 0,
  "cacheRead": 0,
  "cacheWrite": 0,
  "total": 0
}
```

其中 `total = input + output + reasoning + cacheRead + cacheWrite`。实验侧保持同一语义。训练和测试指标表中 `avg_in_tok_cached` 的数值显示为 `input + cacheRead + cacheWrite (cacheRead)`，即括号外是全部输入侧 token，括号内是其中命中缓存的 token。`avg_out_tok` 对应 `output + reasoning`，总 token 对应输入侧与输出侧之和。

如果 opencode 事件没有显式 cache read/write 字段，真实缓存命中无法从总 token 里反推出。当前解析器会读取常见的 `cacheRead`、`cache_read`、`cacheWrite`、`cache_write` 和嵌套 `cache.read/cache.write` 字段；没有这些字段时，`cacheRead/cacheWrite` 为 0，`In-Tok.(Cached)` 退化为普通 input token。

## Algorithm

实验包含两种 skill 进化设置：

- `trace-only`: 只用任务执行 trace 和 verifier outcome。
- `trace-fb`: 在 trace 基础上加入 simulated user feedback；失败时可 fork 一条改进路径，形成 `tau-` 与 `tau+` 的 pair evidence。

每轮 distill 流程：

1. 当前 pool 被 materialize 到任务 workspace。
2. opencode 解决当前 SWE-bench 任务。
3. evaluator 给出 verifier resolved。
4. `trace-only` 不向 trace 追加模拟用户反馈；single evidence 完全由 verifier 的 `resolved` 划分为 `single_success` 或 `single_failure`。
5. `trace-fb` 使用固定、可复现的模拟用户反馈，不调用额外反馈 LLM。成功 trace 在末尾追加默认成功反馈；失败 trace 在末尾追加默认失败反馈，并在启用 fork 时以同一句反馈作为 correction hint，从同一 session 和 workspace 继续执行。
6. 只有 `tau-.resolved=False` 且 fork continuation `tau+.resolved=True` 时才建立 pair evidence。成功的 continuation 在末尾追加默认成功反馈；fork 仍失败时，带有默认失败反馈的原 trace 保持为 `single_failure`。
7. evidence 被压缩为 evidence digest；所有 skill、write/edit、error 和 test/verification action 强制保留，长 trace 的其余 action 保留首尾并有界采样。pair digest 同时保留 `tau-` 和 `tau+` 的反馈消息预览；结构化 trace bundle 转换函数保留用于复现实验记录。
8. 所有 single 和 pair evidence 都先进入 LLM estimator。默认 gate 为 `reusable >= 0.34`、`safe >= 0.60`、`informative >= 0.50`；失败 outcome 和 feedback 是这三项判断的证据，不是额外 accept gate。LLM estimator 调用失败时 fail-closed。
9. pool selector 只查看全池 skill 的 name 和 description，选择最多 `2 * max_skills_per_patch` 个可能需要读取正文的 skill；它在选择阶段看不到正文。
10. distiller 查看全量 pool 的 name/description 摘要和被选中 skill 的完整正文，使用与 evidence kind 对应的 success、failure 或 pair flow 提出 PatchOp candidates。全量摘要只用于判断重叠和路由冲突；revise、merge、remove 的 `target_id`/`merge_ids` 只能引用已选子集中的精确 `skill_ref`。
11. distiller prompt 要求只保存跨问题可复用的执行能力，不保存具体 bug 的根因或修复配方，并排除依赖安装、editable install、环境修复和 bootstrap 步骤。对于迭代型搜索、编辑或验证 workflow，prompt 要求禁止重复未变化的命令，并在连续两轮 edit-test 没有成功或新证据时重新定位；scorer 会对缺少这些约束的候选降低评分。
12. scorer 为每个 candidate 输出 `reuse`、`correctness`、`token_r`、`time_r`、`call_r`。代码要求 reuse/correctness 通过硬门槛，三项成本预测都严格为正，再对三项相对成本降低取几何平均。
13. score 达到阈值的候选按得分排序，每轮最多应用 `max_skills_per_patch` 个 PatchOp。

成功或失败的 single trace 以及成功 recovery pair 都可以调用 estimator 并有机会更新 pool。是否进入 distiller 由 reusable、safe、informative 三项分数决定。候选名称、正文和 PatchOp 结构不合规时触发 LLM 重试；description 必须为单行并包含 pre-action `Skip when` cue，200 字符是 prompt 中的紧凑性目标。skill content 必须包含 `## Skip`，并受默认 1200 字符硬上限约束，超限候选会重试或被丢弃，不会被截断。

落盘的 skill 使用 OpenCode 可读取的 Markdown 格式：

```markdown
---
name: running-project-tests
description: "What it does. Use when positive cues apply. Skip when negative cues apply."
---

## Trigger
...

## Skip
...

## Workflow
...

## Verify
...

## Stop
...
```

scorer 当前接受规则：

```text
cost_gate = 1[token_r > 0 and time_r > 0 and call_r > 0]
efficiency = geometric_mean(token_r, time_r, call_r)
score = 1[reuse >= 0.50] * 1[correctness >= 0.50] * cost_gate * efficiency
accept = score >= 0.10
```

门控保证预测的成本收益不能补偿 correctness 或可复用性退化，而且任一成本维度为零或负数时 candidate 都不 eligible。几何平均要求三项部署成本预测都为正，同时避免额外人工权重。

scorer 直接输出 `reuse`、`correctness` 和三项有符号相对变化 `token_r`、`time_r`、`call_r`。正数表示预计降低，`0` 表示不变或证据不足，负数表示预计增加。分项和代码聚合结果都会写入 candidate 日志。由于系统面向在线任务，scorer 使用当前 evidence 做即时预测，不为候选 skill 重新运行真实任务。

训练阶段表格按已完成 setting 累积展示：base 完成后显示 base，trace-only 完成后显示 base 与 trace-only，trace-fb 完成后显示三者。整体和 difficulty 表中的非 base 行都使用与 final eval 相同的相对 base 百分比口径。

## Online Integration

在线接入时建议复用 `Trace`、`Evidence`、`TraceEstimator`、`SkillDistiller`、
`SkillPool/PatchOp` 和 prompts，把 SWE-bench runner/evaluator/dataset 替换为
业务系统的 trace、可信 outcome、模型网关和版本化存储适配器。当前
`SkillPool.save()` 与 `run_distillation()` 面向单进程实验，不提供线上并发更新、
事务发布或回滚能力。

完整的模块边界、单条更新伪代码、并发/安全要求和验收清单见
[INTEGRATION.md](INTEGRATION.md)。

## Experiment Design Notes

主结果应报告 `test_frozen_pool`：在 `D_distill` 学到 skill 后冻结 pool，再在 held-out `D_test` 上评估。`train_prequential` 应作为在线学习过程的辅助结果，用来解释 pool 如何在 stream 中变化。

`run-all` 支持多 seed 的多轮 `distill + eval`，但默认配置当前只包含 seed 42。每个 seed 都会重新划分采样顺序、重新 distill、再做多次 final eval。论文中更合理的主统计是跨 seed 的均值和方差；同一 seed 内的 eval repeats 主要用于缓解 LLM 采样和 API 抖动。

stream order 对在线进化影响很大。默认 `subsystem_clustered_stream: true` 使用 split 文件中的 `repo + primary subsystem` cluster，使同一子系统任务在训练流中连续出现。该 cluster 来自数据集 patch 路径，只用于受控实验排序，不会传给 executor；论文中应明确它是 oracle-controlled online stream，而不是自然线上流量。

固定 split 先按 `repo + primary subsystem` 划分完整的 train/test，再从 test 侧按 difficulty 采样，并从 train 侧优先选择覆盖这些 test cluster 的任务。这是面向 skill 进化的有意设计：保证训练与测试任务具有可转移的项目/子系统相似性，衡量的是 oracle-controlled same-subsystem transfer，而不是跨项目或自然流量泛化。因此 `train_prequential` 用于模拟在线更新过程，`test_frozen_pool` 用于验证对同项目、同子系统 held-out 任务的泛化。当前完整 split 的 143 个 test task 都有同 cluster 的 train sibling，其中 108 个属于至少有 3 个 train sibling 的 `test_core_high_transfer` 子集。

`trace-fb` 的反馈是由 verifier outcome 决定的固定模板模拟输入，不是真实用户反馈。它适合作为 binary verifier-feedback simulation 报告，不能直接声称等价于真实在线人类反馈。

## Speed And External Factors

默认并发：

```text
run.concurrency: 24
evaluator.max_workers: 12
```

当前环境虽可见 64 个在线 CPU，但 cgroup 配额约为 20 CPU/80 GiB；主任务包含大量 API 等待，因此允许 `run.concurrency` 略高于 CPU 配额。verifier 是本地 CPU/内存密集工作，使用更保守的 12 workers。

设备不一定会被吃满，原因包括：

- 主任务瓶颈多在 LLM API 延迟和限流，不在 CPU。
- crun 为每个 instance 使用独立 rootfs，不同 instance 可以并行 grading。
- rootfs 拉取和解压受网络、磁盘 I/O、registry、代理影响。
- DeepSeek 服务端排队、网络抖动、模型负载会直接影响时间和成本。
- opencode retry、timeout、fork 是否触发会改变单任务运行时间。

提高速度的优先顺序：

1. 使用多个 `DEEPSEEK_API_KEYS`。
2. 在限流可控时提高 `--concurrency`。
3. 预热 SWE-bench rootfs/cache。
4. 使用 `SE_NO_CLEAN=1` 减少重复清理。
5. 减少不必要的 estimator/distiller/scorer 重试，但这会改变 API 故障下的容错率。

正式对比实验要固定 key 池、concurrency、backend、proxy、timeout、seed、模型版本和 stream order。
