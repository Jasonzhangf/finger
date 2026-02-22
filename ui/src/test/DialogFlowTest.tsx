import React, { useState } from 'react';

interface TestResult {
  step: string;
  status: 'pending' | 'success' | 'error';
  message?: string;
  timestamp?: string;
}

export const DialogFlowTest: React.FC = () => {
  const [results, setResults] = useState<TestResult[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  const addResult = (step: string, status: TestResult['status'], message?: string) => {
    setResults(prev => [...prev, { step, status, message, timestamp: new Date().toISOString() }]);
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const testSendUserInput = async () => {
    setIsRunning(true);
    setResults([]);

    try {
      addResult('发送初始任务', 'pending');
      const task = userInput || '搜索 deepseek 最近一年的研究成果';
      
      const response = await fetch('/api/v1/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'orchestrator-loop', message: { content: task }, blocking: false }),
      });

      const data = await response.json();
      
      if (data.success) {
        addResult('发送初始任务', 'success', `Message ID: ${data.messageId}`);
        addResult('等待工作流创建', 'pending');
        await sleep(2000);
        
        const workflowsRes = await fetch('/api/v1/workflows');
        const workflows = await workflowsRes.json();
        const workflow = workflows[0];
        
        if (workflow) {
          addResult('等待工作流创建', 'success', `Workflow: ${workflow.id}`);
          addResult('发送后续输入', 'pending');
          
          const followupRes = await fetch('/api/v1/workflow/input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId: workflow.id, input: '优先分析最新的论文' }),
          });
          
          const followupData = await followupRes.json();
          if (followupData.success) {
            addResult('发送后续输入', 'success', 'Input accepted');
          } else {
            addResult('发送后续输入', 'error', followupData.error);
          }
          
          addResult('检查任务进度', 'pending');
          await sleep(3000);
          
          const tasksRes = await fetch(`/api/v1/workflows/${workflow.id}/tasks`);
          const tasks = await tasksRes.json();
          addResult('检查任务进度', 'success', `Tasks: ${tasks.length}`);
        } else {
          addResult('等待工作流创建', 'error', 'No workflow found');
        }
      } else {
        addResult('发送初始任务', 'error', data.error);
      }
    } catch (error) {
      addResult('测试失败', 'error', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div style={{ padding: '20px', background: '#1e293b', color: '#e2e8f0', minHeight: '400px' }}>
      <h2>Dialog Flow Test</h2>
      <div style={{ marginBottom: '20px' }}>
        <input
          type="text"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="Enter test task..."
          style={{ padding: '8px', width: '300px', marginRight: '10px', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' }}
        />
        <button onClick={testSendUserInput} disabled={isRunning} style={{ padding: '8px 16px', background: isRunning ? '#64748b' : '#2563eb', color: 'white', border: 'none', cursor: isRunning ? 'not-allowed' : 'pointer' }}>
          {isRunning ? 'Running...' : 'Run Test'}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {results.map((result, idx) => (
          <div key={idx} style={{ padding: '12px', background: result.status === 'success' ? '#064e3b' : result.status === 'error' ? '#7f1d1d' : '#1e3a5f', borderRadius: '4px', borderLeft: `4px solid ${result.status === 'success' ? '#22c55e' : result.status === 'error' ? '#ef4444' : '#f59e0b'}` }}>
            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
              {result.status === 'success' ? '✅' : result.status === 'error' ? '❌' : '⏳'} {result.step}
            </div>
            {result.message && <div style={{ fontSize: '13px', opacity: 0.8 }}>{result.message}</div>}
            {result.timestamp && <div style={{ fontSize: '11px', opacity: 0.6 }}>{new Date(result.timestamp).toLocaleTimeString()}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};
