import { WorkflowContainer } from './components/WorkflowContainer/WorkflowContainer.js';
import './App.css';
import { useEffect } from 'react';

function App() {
  useEffect(() => {
    console.log('[App] Component mounted');
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0e1217', color: '#e4e7eb', overflow: 'hidden' }}>
      <WorkflowContainer />
    </div>
  );
}

export default App;
