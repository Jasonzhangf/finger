/**
 * SchedulesTab - 定时任务与心跳任务统一监控面板
 */

import React, { useState } from 'react';
import { useSchedules } from '../../hooks/useSchedules.js';
import type { ClockTimer } from '../../api/client.js';
import './ClockTasksTab.css';

type PanelMode = 'heartbeat' | 'clock';

interface ClockCreateFormData {
  message: string;
  schedule_type: 'delay' | 'at' | 'cron';
  delay_seconds?: number;
  at?: string;
  cron?: string;
  timezone?: string;
  repeat?: boolean;
  max_runs?: number;
  inject: {
    agentId: string;
    projectPath?: string;
    prompt: string;
  };
}

const DEFAULT_FORM_DATA: ClockCreateFormData = {
  message: '',
  schedule_type: 'delay',
  delay_seconds: 60,
  timezone: 'Asia/Shanghai',
  inject: {
    agentId: 'finger-system-agent',
    prompt: '',
  },
};

function formatDateTime(value?: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function summarizeSchedule(timer: ClockTimer): string {
  if (timer.schedule_type === 'delay') return `Delay ${timer.delay_seconds ?? '-'}s`;
  if (timer.schedule_type === 'at') return `At ${timer.at ?? '-'}`;
  return `Cron ${timer.cron ?? '-'} ${timer.timezone ?? ''}`.trim();
}

export const ClockTasksTab: React.FC = () => {
  const {
    clockTimers,
    heartbeatTasks,
    heartbeatStatus,
    isLoading,
    error,
    refresh,
    createClock,
    updateClock,
    cancelClock,
    setHeartbeat,
    addTask,
    completeTask,
    removeTask,
  } = useSchedules();

  const [mode, setMode] = useState<PanelMode>('heartbeat');
  const [showClockCreate, setShowClockCreate] = useState(false);
  const [clockForm, setClockForm] = useState<ClockCreateFormData>(DEFAULT_FORM_DATA);
  const [editingTimerId, setEditingTimerId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState('');
  const [heartbeatInterval, setHeartbeatInterval] = useState<number>(heartbeatStatus?.intervalMs ?? 300000);
  const [heartbeatDispatch, setHeartbeatDispatch] = useState<'mailbox' | 'dispatch'>((heartbeatStatus?.dispatch as 'mailbox' | 'dispatch') ?? 'mailbox');
  const [newTaskText, setNewTaskText] = useState('');
  const [newTaskSection, setNewTaskSection] = useState('待办检查');

  React.useEffect(() => {
    if (heartbeatStatus?.intervalMs) setHeartbeatInterval(heartbeatStatus.intervalMs);
    if (heartbeatStatus?.dispatch === 'mailbox' || heartbeatStatus?.dispatch === 'dispatch') {
      setHeartbeatDispatch(heartbeatStatus.dispatch);
    }
  }, [heartbeatStatus?.intervalMs, heartbeatStatus?.dispatch]);

  const handleCreateClock = async (): Promise<void> => {
    if (!clockForm.message.trim()) return;
    const result = await createClock(clockForm);
    if (result.success) {
      setShowClockCreate(false);
      setClockForm(DEFAULT_FORM_DATA);
      return;
    }
    alert(`创建失败: ${result.error}`);
  };

  const handleUpdateClockMessage = async (timer: ClockTimer): Promise<void> => {
    if (!editingMessage.trim()) return;
    const result = await updateClock({
      timer_id: timer.timer_id,
      message: editingMessage.trim(),
    });
    if (result.success) {
      setEditingTimerId(null);
      setEditingMessage('');
      return;
    }
    alert(`更新失败: ${result.error}`);
  };

  const handleSaveHeartbeatConfig = async (): Promise<void> => {
    const result = await setHeartbeat({
      enabled: true,
      intervalMs: heartbeatInterval,
      dispatch: heartbeatDispatch,
    });
    if (!result.success) {
      alert(`保存失败: ${result.error}`);
    }
  };

  const handleToggleHeartbeat = async (): Promise<void> => {
    const enabled = !(heartbeatStatus?.enabled ?? false);
    const result = await setHeartbeat({
      enabled,
      intervalMs: heartbeatInterval,
      dispatch: heartbeatDispatch,
    });
    if (!result.success) {
      alert(`操作失败: ${result.error}`);
    }
  };

  const handleAddTask = async (): Promise<void> => {
    if (!newTaskText.trim()) return;
    const result = await addTask({ text: newTaskText.trim(), section: newTaskSection.trim() || '未分类' });
    if (!result.success) {
      alert(`添加任务失败: ${result.error}`);
      return;
    }
    setNewTaskText('');
  };

  return (
    <div className="clock-tasks-tab">
      <div className="tab-header">
        <h3>⏱️ 定时任务中心</h3>
        <div className="header-actions">
          <button className="btn-refresh" onClick={() => void refresh()} disabled={isLoading}>{isLoading ? '刷新中...' : '🔄 刷新'}</button>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="schedule-mode-tabs">
        <button className={`mode-tab ${mode === 'heartbeat' ? 'active' : ''}`} onClick={() => setMode('heartbeat')}>Heartbeat 任务</button>
        <button className={`mode-tab ${mode === 'clock' ? 'active' : ''}`} onClick={() => setMode('clock')}>Clock 定时器</button>
      </div>

      {mode === 'heartbeat' && (
        <section className="schedule-panel">
          <div className="panel-block">
            <h4>Heartbeat 配置</h4>
            <div className="heartbeat-config-grid">
              <label>
                启用状态
                <button className={`toggle-btn ${(heartbeatStatus?.enabled ?? false) ? 'enabled' : 'disabled'}`} onClick={() => void handleToggleHeartbeat()}>
                  {(heartbeatStatus?.enabled ?? false) ? '已启用' : '已停用'}
                </button>
              </label>
              <label>
                间隔(ms)
                <input type="number" min={60000} max={3600000} step={60000} value={heartbeatInterval} onChange={(e) => setHeartbeatInterval(Number(e.target.value) || 300000)} />
              </label>
              <label>
                派发模式
                <select value={heartbeatDispatch} onChange={(e) => setHeartbeatDispatch(e.target.value as 'mailbox' | 'dispatch')}>
                  <option value="mailbox">mailbox</option>
                  <option value="dispatch">dispatch</option>
                </select>
              </label>
              <div className="config-actions">
                <button className="btn-create" onClick={() => void handleSaveHeartbeatConfig()}>保存配置</button>
              </div>
            </div>
            <div className="stats-line">
              pending={heartbeatStatus?.taskStats?.pending ?? 0} / completed={heartbeatStatus?.taskStats?.completed ?? 0} / total={heartbeatStatus?.taskStats?.total ?? 0}
            </div>
          </div>

          <div className="panel-block">
            <h4>添加 Heartbeat 任务</h4>
            <div className="task-create-row">
              <input
                type="text"
                placeholder="任务描述"
                value={newTaskText}
                onChange={(e) => setNewTaskText(e.target.value)}
              />
              <input
                type="text"
                placeholder="分组"
                value={newTaskSection}
                onChange={(e) => setNewTaskSection(e.target.value)}
              />
              <button className="btn-create" onClick={() => void handleAddTask()}>添加</button>
            </div>
          </div>

          <div className="panel-block">
            <h4>Heartbeat 任务表</h4>
            <table className="schedule-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>分组</th>
                  <th>任务内容</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {heartbeatTasks.map((task, idx) => (
                  <tr key={`${task.text}-${task.ts}-${idx}`}>
                    <td>{task.status === 'completed' ? '✅ 已完成' : '⏳ 待办'}</td>
                    <td>{task.section || '-'}</td>
                    <td>{task.text || '-'}</td>
                    <td>{formatDateTime(task.ts)}</td>
                    <td>
                      {task.status !== 'completed' && task.text && (
                        <button className="btn-inline" onClick={() => void completeTask(task.text!)}>完成</button>
                      )}
                      {task.text && <button className="btn-inline danger" onClick={() => void removeTask(task.text!)}>删除</button>}
                    </td>
                  </tr>
                ))}
                {heartbeatTasks.length === 0 && (
                  <tr><td colSpan={5} className="table-empty">暂无 Heartbeat 任务</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {mode === 'clock' && (
        <section className="schedule-panel">
          <div className="panel-block">
            <div className="panel-title-row">
              <h4>Clock 定时器表</h4>
              <button className="btn-create" onClick={() => setShowClockCreate((v) => !v)}>{showClockCreate ? '收起' : '新增定时器'}</button>
            </div>

            {showClockCreate && (
              <div className="clock-create-form">
                <div className="form-grid">
                  <label>描述<input value={clockForm.message} onChange={(e) => setClockForm({ ...clockForm, message: e.target.value })} /></label>
                  <label>类型
                    <select value={clockForm.schedule_type} onChange={(e) => setClockForm({ ...clockForm, schedule_type: e.target.value as ClockCreateFormData['schedule_type'] })}>
                      <option value="delay">delay</option>
                      <option value="at">at</option>
                      <option value="cron">cron</option>
                    </select>
                  </label>
                  {clockForm.schedule_type === 'delay' && <label>延迟(秒)<input type="number" value={clockForm.delay_seconds ?? 60} onChange={(e) => setClockForm({ ...clockForm, delay_seconds: Number(e.target.value) || 60 })} /></label>}
                  {clockForm.schedule_type === 'at' && <label>时间<input type="datetime-local" value={clockForm.at ?? ''} onChange={(e) => setClockForm({ ...clockForm, at: e.target.value })} /></label>}
                  {clockForm.schedule_type === 'cron' && <label>Cron<input value={clockForm.cron ?? ''} onChange={(e) => setClockForm({ ...clockForm, cron: e.target.value })} placeholder="*/5 * * * *" /></label>}
                  <label>目标 Agent<input value={clockForm.inject.agentId} onChange={(e) => setClockForm({ ...clockForm, inject: { ...clockForm.inject, agentId: e.target.value } })} /></label>
                  <label>项目路径<input value={clockForm.inject.projectPath ?? ''} onChange={(e) => setClockForm({ ...clockForm, inject: { ...clockForm.inject, projectPath: e.target.value } })} /></label>
                </div>
                <label>提示词<textarea rows={2} value={clockForm.inject.prompt} onChange={(e) => setClockForm({ ...clockForm, inject: { ...clockForm.inject, prompt: e.target.value } })} /></label>
                <div className="form-actions"><button className="btn-create" onClick={() => void handleCreateClock()}>创建</button></div>
              </div>
            )}

            <table className="schedule-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>描述</th>
                  <th>调度</th>
                  <th>下次触发</th>
                  <th>运行次数</th>
                  <th>目标 Agent</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {clockTimers.map((timer) => (
                  <tr key={timer.timer_id}>
                    <td>{timer.status}</td>
                    <td>
                      {editingTimerId === timer.timer_id ? (
                        <input value={editingMessage} onChange={(e) => setEditingMessage(e.target.value)} />
                      ) : (
                        timer.message
                      )}
                    </td>
                    <td>{summarizeSchedule(timer)}</td>
                    <td>{formatDateTime(timer.next_fire_at)}</td>
                    <td>{timer.run_count}</td>
                    <td>{timer.inject?.agentId ?? '-'}</td>
                    <td>
                      {editingTimerId === timer.timer_id ? (
                        <>
                          <button className="btn-inline" onClick={() => void handleUpdateClockMessage(timer)}>保存</button>
                          <button className="btn-inline" onClick={() => setEditingTimerId(null)}>取消</button>
                        </>
                      ) : (
                        <>
                          <button className="btn-inline" onClick={() => { setEditingTimerId(timer.timer_id); setEditingMessage(timer.message); }}>编辑描述</button>
                          {timer.status === 'active' && <button className="btn-inline danger" onClick={() => void cancelClock(timer.timer_id)}>取消</button>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {clockTimers.length === 0 && (
                  <tr><td colSpan={7} className="table-empty">暂无 Clock 定时器</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};
