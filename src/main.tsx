import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './rich-email.css'

class ErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}
  static getDerivedStateFromError(){return{failed:true}}
  componentDidCatch(error:Error,info:ErrorInfo){console.error('SnowFire Mail renderer failed',error,info)}
  render(){return this.state.failed?<main className="fatal-error"><img src="./brand/snowfire_logo_title_right_light.svg" alt="SnowFire"/><span>MAIL / RECOVERY</span><h1>Something interrupted your inbox.</h1><p>Your Gmail data is safe. Reload the interface to reconnect.</p><button onClick={()=>window.location.reload()}>Reload SnowFire Mail</button></main>:this.props.children}
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>)
