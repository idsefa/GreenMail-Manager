import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import DeviceDetail from './pages/DeviceDetail';
import Messages from './pages/Messages';
import InterfaceLogs from './pages/InterfaceLogs';
import SMS from './pages/SMS';
import Calls from './pages/Calls';
import PushRules from './pages/PushRules';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:devId" element={<DeviceDetail />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/interface-logs" element={<InterfaceLogs />} />
        <Route path="/sms" element={<SMS />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/push-rules" element={<PushRules />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
