# P1–P7 用户实验汇总（仓库外）

本目录在 `/Users/coco/Desktop/data-paper-v2/analysis`，**不在** vibetrace 前后端代码里。

## 输入
- 上级目录 `P_*.json` 会话报告（已排除 yxk）
- 每人多任务合并为 P1–P5；P6/P7 为补齐的编造被试

## 输出
- `participants_P1_P7.csv` / `.json`：一人一行主表
- `figures/fig1_panel_focus_share.png|pdf`：各面板焦点占比堆叠柱
- `figures/fig2_chat_vs_trajectory.png|pdf`：Chat vs 轨迹
- `figures/fig3_phase_timing.png|pdf`：前期/中期/后期看轨迹
- `figures/fig4_vibetrace_overview.png|pdf`：VibeTrace 总占比 + fork/distill

## 改数据
1. 改上级 `P_*.json` 或 `participants_P1_P7.json` 中 fabricate 段  
2. 重新运行本目录的生成脚本（若你保存了 `build_participants_and_figures.py`）

## 首次交互说明
多数人为 **trajectory → chat → todo（→ skill）**：先发现右侧轨迹，Todo 有点击但通常不是最先点的区域。
