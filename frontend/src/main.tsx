import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DataSourceProvider } from './lib/dataSourceContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DataSourceProvider>
      <App />
    </DataSourceProvider>
  </StrictMode>
);
