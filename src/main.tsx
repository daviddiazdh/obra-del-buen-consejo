import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './app-overrides.css'
import './portal.css'
import './profile.css'
import './scheduler.css'
import './admin.css'
import './admin-config.css'
import './report-editor.css'
import './pagination.css'
import './report-history.css'
import './modal.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
