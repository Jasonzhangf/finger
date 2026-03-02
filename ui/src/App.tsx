import { WorkflowContainer } from './components/WorkflowContainer/WorkflowContainer.js';
import { DialogFlowTest } from './test/DialogFlowTest.js';
import TestPanel from './pages/TestPanel/index.js';
import './App.css';
import { useEffect, useState } from 'react';

function App() {
 const [testMode, setTestMode] = useState(false);
  const [panelMode, setPanelMode] = useState<'main' | 'test' | 'qa'>('main');

  useEffect(() => {
    console.log('[App] Component mounted');
    // Check URL param for test mode: ?test=true
    const params = new URLSearchParams(window.location.search);
    if (params.get('test') === 'true') {
      setTestMode(true);
    }
    if (params.get('panel') === 'qa' || params.get('panel') === 'test') {
      setPanelMode(params.get('panel') as 'qa' | 'test');
    }
  }, []);

  // QA Panel mode - full test panel
  if (panelMode === 'qa' || panelMode === 'test') {
    return (
      <div style={{ width: '100vw', minHeight: '100vh', background: '#0e1217', color: '#e4e7eb' }}>
        <TestPanel />
      </div>
    );
  }

  if (testMode) {
    return (
      <div style={{ width: '100vw', minHeight: '100vh', background: '#0e1217', color: '#e4e7eb' }}>
        <DialogFlowTest />
        <div style={{ padding: '20px' }}>
          <WorkflowContainer />
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0e1217', color: '#e4e7eb', overflow: 'hidden' }}>
      <WorkflowContainer />
    </div>
  );
}

export default App;
