import { Link, useLocation } from 'react-router-dom';
import { useLang } from '../i18n.jsx';

export default function Layout({ children }) {
  const location = useLocation();
  const { t, lang, setLang } = useLang();

  const navItems = [
    { path: '/', label: t('nav.dashboard'), icon: 'D' },
    { path: '/devices', label: t('nav.devices'), icon: 'V' },
    { path: '/messages', label: t('nav.messages'), icon: 'M' },
    { path: '/interface-logs', label: t('nav.interfaceLogs'), icon: 'L' },
    { path: '/sms', label: t('nav.sms'), icon: 'S' },
    { path: '/calls', label: t('nav.calls'), icon: 'C' },
    { path: '/push-rules', label: t('nav.pushRules'), icon: 'P' },
  ];

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 text-gray-300 flex-shrink-0">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="bg-green-500 text-white rounded px-2 py-0.5 text-sm font-mono">GM</span>
            GreenMail Manager
          </h1>
        </div>
        <nav className="mt-2">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`block px-4 py-2.5 text-sm hover:bg-gray-800 transition-colors ${
                location.pathname === item.path
                  ? 'bg-gray-800 text-white border-l-2 border-green-500'
                  : ''
              }`}
            >
              <span className="inline-block w-6 text-center font-mono text-xs bg-gray-700 rounded mr-2 px-1">
                {item.icon}
              </span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-0 left-0 w-56 p-4 border-t border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">GreenMail Manager v1.0</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLang('zh')}
              className={`px-2 py-1 text-xs rounded ${
                lang === 'zh' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              中
            </button>
            <button
              onClick={() => setLang('en')}
              className={`px-2 py-1 text-xs rounded ${
                lang === 'en' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              EN
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
