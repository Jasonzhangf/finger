/**
 * ClockTasksTab - 定时任务监控 Tab
 */

import React, { useState, useCallback } from 'react';
import { useClockTasks } from '../../hooks/useClockTasks.js';
import type { ClockTimer } from '../../api/client.js';
import './ClockTasksTab.css';

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
    agentId: 'finger-orchestrator-agent',
    prompt: '',
  },
};

export const ClockTasksTab: React.FC = () => {
  const { timers, isLoading, error, refresh, create, cancel, timersByProject } = useClockTasks();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState<ClockCreateFormData>(DEFAULT_FORM_DATA);
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!formData.message.trim()) return;
    setCreating(true);
    const result = await create(formData);
    setCreating(false);
    if (result.success) {
      setShowCreateForm(false);
      setFormData(DEFAULT_FORM_DATA);
    } else {
      alert(`创建失败: ${result.error}`);
    }
  }, [formData, create]);

  const handleCancel = useCallback(async (timerId: string) => {
    if (!confirm('确定要取消这个定时任务吗？')) return;
    const result = await cancel(timerId);
    if (!result.success) {
      alert(`取消失败: ${result.error}`);
    }
  }, [cancel]);

  const formatNextFireAt = (timer: ClockTimer): string => {
    if (!timer.next_fire_at) return '-';
    const date = new Date(timer.next_fire_at);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: ClockTimer['status']) => {
    const badges = {
      active: { label: '活跃', className: 'status-active' },
      completed: { label: '已完成', className: 'status-completed' },
      canceled: { label: '已取消', className: 'status-canceled' },
    };
    return badges[status] || badges.active;
  };

  if (showCreateForm) {
    return (
      <div className="clock-tasks-tab">
        <div className="create-form-header">
          <h3>创建定时任务</h3>
          <button className="btn-close" onClick={() => setShowCreateForm(false)}>✕</button>
        </div>
        <div className="create-form">
          <div className="form-group">
            <label>消息描述</label>
            <input
              type="text"
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              placeholder="定时任务描述"
            />
          </div>
          <div className="form-group">
            <label>调度类型</label>
            <select
              value={formData.schedule_type}
              onChange={(e) => setFormData({ ...formData, schedule_type: e.target.value as any })}
            >
              <option value="delay">延迟执行</option>
              <option value="at">指定时间</option>
              <option value="cron">Cron 表达式</option>
            </select>
          </div>
          {formData.schedule_type === 'delay' && (
            <div className="form-group">
              <label>延迟秒数</label>
              <input
                type="number"
                value={formData.delay_seconds || 60}
                onChange={(e) => setFormData({ ...formData, delay_seconds: parseInt(e.target.value) })}
              />
            </div>
          )}
          {formData.schedule_type === 'at' && (
            <div className="form-group">
              <label>执行时间 (ISO格式)</label>
              <input
                type="datetime-local"
                value={formData.at || ''}
                onChange={(e) => setFormData({ ...formData, at: e.target.value })}
              />
            </div>
          )}
          {formData.schedule_type === 'cron' && (
            <>
              <div className="form-group">
                <label>Cron 表达式</label>
                <input
                  type="text"
                  value={formData.cron || ''}
                  onChange={(e) => setFormData({ ...formData, cron: e.target.value })}
                  placeholder="0 9 * * *"
                />
              </div>
              <div className="form-group">
                <label>重复</label>
                <input
                  type="checkbox"
                  checked={formData.repeat || false}
                  onChange={(e) => setFormData({ ...formData, repeat: e.target.checked })}
                />
              </div>
            </>
          )}
          <div className="form-group">
            <label>目标 Agent</label>
            <input
              type="text"
              value={formData.inject.agentId}
              onChange={(e) => setFormData({ ...formData, inject: { ...formData.inject, agentId: e.target.value } })}
            />
          </div>
          <div className="form-group">
            <label>项目路径</label>
            <input
              type="text"
              value={formData.inject.projectPath || ''}
              onChange={(e) => setFormData({ ...formData, inject: { ...formData.inject, projectPath: e.target.value } })}
              placeholder="留空则为系统目录"
            />
          </div>
          <div className="form-group">
            <label>执行提示词</label>
            <textarea
              value={formData.inject.prompt}
              onChange={(e) => setFormData({ ...formData, inject: { ...formData.inject, prompt: e.target.value } })}
              placeholder="任务内容..."
              rows={3}
            />
          </div>
          <div className="form-actions">
            <button className="btn-cancel" onClick={() => setShowCreateForm(false)}>取消</button>
            <button className="btn-create" onClick={handleCreate} disabled={creating}>
              {creating ? '创建中...' : '创建'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="clock-tasks-tab">
      <div className="tab-header">
        <h3>⏰ 定时任务</h3>
        <div className="header-actions">
          <button className="btn-refresh" onClick={refresh} disabled={isLoading}>
            {isLoading ? '刷新中...' : '🔄 刷新'}
          </button>
          <button className="btn-create" onClick={() => setShowCreateForm(true)}>
            ➕ 新建
          </button>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div className="projects-list">
        {Array.from(timersByProject.entries()).map(([projectPath, projectTimers]) => (
          <div key={projectPath} className="project-group">
            <div className="project-header">
              <span className="project-name">📁 {projectPath.split('/').pop()}</span>
              <span className="project-count">{projectTimers.length} 个任务</span>
            </div>
            <div className="timers-list">
              {projectTimers.map((timer) => {
                const badge = getStatusBadge(timer.status);
                return (
                  <div key={timer.timer_id} className="timer-item">
                    <div className="timer-header">
                      <span className={`status-badge ${badge.className}`}>{badge.label}</span>
                      <span className="timer-type">{timer.schedule_type}</span>
                      {timer.status === 'active' && (
                        <button
                          className="btn-cancel-timer"
                          onClick={() => handleCancel(timer.timer_id)}
                        >
                          取消
                        </button>
                      )}
                    </div>
                    <div className="timer-message">{timer.message}</div>
                    <div className="timer-meta">
                      <span>下次执行: {formatNextFireAt(timer)}</span>
                      <span>已执行: {timer.run_count}次</span>
                    </div>
                    {timer.inject && (
                      <div className="timer-inject">
                        <span>→ {timer.inject.agentId}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {timers.length === 0 && !isLoading && (
          <div className="empty-state">暂无定时任务</div>
        )}
      </div>
    </div>
  );
};
