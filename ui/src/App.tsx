import { AppLayout } from './components/layout';
import { LeftSidebar } from './components/LeftSidebar';
import { RightPanel } from './components/RightPanel';
import { BottomPanel } from './components/BottomPanel';
import { OrchestrationCanvas } from './components/OrchestrationCanvas';
import './App.css';

function App() {
  return (
    <AppLayout
      leftSidebar={<LeftSidebar />}
      canvas={<OrchestrationCanvas />}
      rightPanel={<RightPanel />}
      bottomPanel={<BottomPanel />}
    />
  );
}

export default App;
