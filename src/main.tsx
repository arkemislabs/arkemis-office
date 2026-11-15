import React, {lazy, Suspense} from 'react';import {createRoot} from 'react-dom/client';import App from './App';import './styles.css';import './glass-dialogs.css';
// Presenter View is a window of its own (--studio-presenter): it draws the slide show the opener pushes, not the app.
const PresenterWindow=lazy(()=>import('./apps/prism/presenter/PresenterWindow'));
const presenting=!!(window as any).studio?.presenterOf;
createRoot(document.getElementById('root')!).render(presenting?<Suspense fallback={null}><PresenterWindow/></Suspense>:<App/>);
