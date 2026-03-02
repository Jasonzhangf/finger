import React, { useState, useEffect, useCallback } from 'react';
import './TestPanel.css';

const TEST_GROUP_ORDER = [
  'blocks',
  'orchestration',
  'agents',
  'ui-contracts',
  'ui-controls-elements',
  'ui-controls-navigation',
  'ui-controls-forms',
  'ui-flows',
  'ui-stability',
] as const;

interface TestCase {
  id: string;
  name: string;
  file: string;
  groupId: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  duration?: number;
  error?: string;
}

interface TestGroup {
  id: string;
  name: string;
  tests: TestCase[];
}

const TestPanel: React.FC = () => {
  const [groups, setGroups] = useState<TestGroup[]>([]);
  const [running, setRunning] = useState(false);
  const [serverUrl] = useState(() => (
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:9999'
  ));
  const [discovered, setDiscovered] = useState(false);
  const [runningTestId, setRunningTestId] = useState<string | null>(null);

  // Scan and discover all tests
  const scanTests = useCallback(async () => {
    try {
      const res = await fetch(`${serverUrl}/api/v1/test/scan`);
      if (res.ok) {
        const data = await res.json();
        setGroups(data.groups || []);
        setDiscovered(true);
      }
    } catch (e) {
      console.error('Failed to scan tests:', e);
    }
  }, [serverUrl]);

  // Fetch current test status
  const fetchTestStatus = useCallback(async () => {
    try {
      const res = await fetch(`${serverUrl}/api/v1/test/status`);
      if (res.ok) {
        const data = await res.json();
        if (data.groups) {
          setGroups(data.groups);
        }
      }
    } catch (e) {
      console.error('Failed to fetch test status:', e);
    }
  }, [serverUrl]);

  // Run specific test
  const runTest = useCallback(async (testId: string) => {
    setRunning(true);
    setRunningTestId(testId);
    try {
      const res = await fetch(`${serverUrl}/api/v1/test/run-test/${encodeURIComponent(testId)}`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        updateTestResult(testId, data);
      }
    } catch (e) {
      console.error('Failed to run test:', e);
    } finally {
      setRunning(false);
      setRunningTestId(null);
    }
  }, [serverUrl]);

  // Run all tests in a group
  const runGroup = useCallback(async (groupId: string) => {
    setRunning(true);
    try {
      const res = await fetch(`${serverUrl}/api/v1/test/run-layer/${groupId}`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.groups) {
          setGroups(data.groups);
        }
      }
    } catch (e) {
      console.error('Failed to run group tests:', e);
    } finally {
      setRunning(false);
    }
  }, [serverUrl]);

  // Run all tests
  const runAllTests = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch(`${serverUrl}/api/v1/test/run-all`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.groups) {
          setGroups(data.groups);
        }
      }
    } catch (e) {
      console.error('Failed to run all tests:', e);
    } finally {
      setRunning(false);
    }
  }, [serverUrl]);

  // Update single test result
  const updateTestResult = useCallback((testId: string, result: any) => {
    setGroups(prev => prev.map(group => ({
      ...group,
      tests: group.tests.map(test =>
        test.id === testId
          ? { ...test, status: result.status, duration: result.duration, error: result.error }
          : test
      ),
    })));
  }, []);

  useEffect(() => {
    scanTests();
  }, [scanTests]);

  const getStatusIcon = (status: TestCase['status']) => {
    switch (status) {
      case 'passed': return '✓';
      case 'failed': return '✗';
      case 'running': return '⋯';
      default: return '○';
    }
  };

  const getStatusClass = (status: TestCase['status']) => {
    return `test-status test-status-${status}`;
  };

  const getGroupStats = (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return { total: 0, passed: 0, failed: 0, pending: 0 };

    const total = group.tests.length;
    const passed = group.tests.filter(t => t.status === 'passed').length;
    const failed = group.tests.filter(t => t.status === 'failed').length;
    const pending = total - passed - failed;

    return { total, passed, failed, pending };
  };

  return (
    <div className="test-panel">
      <div className="test-header">
        <h1>UI 测试中心</h1>
        <div className="test-subtitle">自动注册与执行面板</div>
        <div className="test-actions">
          <button onClick={scanTests} disabled={running} className="scan-btn">
            扫描测试
          </button>
          <button onClick={runAllTests} disabled={running} className="run-all-btn">
            {running ? '运行中...' : '全部测试'}
          </button>
          <button onClick={fetchTestStatus} disabled={running}>
            刷新状态
          </button>
        </div>
      </div>

      {!discovered && (
        <div className="test-empty-state">
          <p>点击「扫描测试」发现可用测试</p>
        </div>
      )}

      <div className="test-groups">
        {TEST_GROUP_ORDER.map(groupId => {
          const group = groups.find(g => g.id === groupId);
          if (!group) return null;

          const stats = getGroupStats(groupId);

          return (
            <div key={groupId} className="test-group">
              <div className="test-group-header">
                <div className="group-title">
                  <h2>{group.name}</h2>
                  <span className="layer-desc">{groupId}</span>
                </div>
                <div className="layer-stats">
                  <span className="stat stat-total">{stats.total} 总</span>
                  <span className="stat stat-passed">{stats.passed} 通过</span>
                  <span className="stat stat-failed">{stats.failed} 失败</span>
                </div>
                <button
                  onClick={() => runGroup(groupId)}
                  disabled={running || group.tests.length === 0}
                  className="run-layer-btn"
                >
                  运行全部
                </button>
              </div>

              <div className="test-list">
                {group.tests.length === 0 ? (
                  <div className="test-empty">暂无测试用例</div>
                ) : (
                  group.tests.map(test => (
                    <div
                      key={test.id}
                      className={`test-item ${runningTestId === test.id ? 'active' : ''}`}
                    >
                      <div className="test-item-header">
                        <span className={getStatusClass(test.status)}>
                          {getStatusIcon(test.status)}
                        </span>
                        <button
                          onClick={() => runTest(test.id)}
                          disabled={running}
                          className="run-single-btn"
                        >
                          运行
                        </button>
                      </div>
                      <div className="test-name">{test.name}</div>
                      <div className="test-file" title={test.file}>{test.file}</div>
                      <div className="test-item-meta">
                        {test.duration && (
                          <span className="test-duration">{test.duration}ms</span>
                        )}
                      </div>
                      {test.error && (
                        <div className="test-error-full">{test.error}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TestPanel;
