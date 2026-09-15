import React, { useState, useEffect } from 'react';
import { UnicornScene } from 'unicornstudio-react';

export default function App() {
  // Form State
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    budget: '',
    goal: '',
    details: ''
  });

  const [formSubmitted, setFormSubmitted] = useState(false);

  // IntersectionObserver for animate-on-scroll elements
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('animate');
          }
        });
      },
      { threshold: 0.15 }
    );

    const elements = document.querySelectorAll('.animate-on-scroll');
    elements.forEach((el) => observer.observe(el));

    return () => {
      elements.forEach((el) => observer.unobserve(el));
    };
  }, []);

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    console.log('Form data submitted:', formData);
    setFormSubmitted(true);
    setTimeout(() => {
      setFormSubmitted(false);
      setFormData({
        name: '',
        email: '',
        budget: '',
        goal: '',
        details: ''
      });
    }, 5000);
  };

  return (
    <div className="relative min-h-screen bg-black text-white antialiased overflow-hidden">
      
      {/* Background Layer (UnicornStudio component) */}
      <div 
        className="aura-background-component absolute top-0 w-full h-[1040px] z-0 overflow-hidden pointer-events-none"
        style={{ filter: 'hue-rotate(90deg)' }}
      >
        <UnicornScene 
          projectId="vTTCp5g4cVl9nwjlT56Z" 
          className="w-full h-full"
        />
      </div>

      {/* Container Layer */}
      <div id="landing-view" className="fixed inset-0 overflow-y-auto z-10 w-full h-full no-scrollbar">
        <div className="max-w-[1280px] mx-auto px-6 w-full relative flex flex-col min-h-screen">
          
          {/* Navigation */}
          <header className="relative w-full py-6 md:py-8 z-50 flex items-center justify-between">
            <a href="/" className="flex items-center">
              <img 
                src="https://i.ibb.co/ZRc2kt2R/logotype.png" 
                alt="Limited Logotype" 
                className="h-5 object-contain" 
              />
            </a>

            {/* Desktop Menu */}
            <div 
              className="hidden md:flex bg-white/5 border border-white/10 rounded-full p-1 shadow-lg backdrop-blur-lg gap-x-1 items-center"
              style={{ position: 'relative', '--border-gradient': 'linear-gradient(135deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0))', '--border-radius-before': '9999px' }}
            >
              <a href="#manifesto" className="px-4 py-1.5 text-xs font-medium font-geist text-zinc-400 hover:text-white transition-colors uppercase tracking-wider">
                Manifesto
              </a>
              <a href="#diferenciais" className="px-4 py-1.5 text-xs font-medium font-geist text-zinc-400 hover:text-white transition-colors uppercase tracking-wider">
                Diferenciais
              </a>
              <a href="#casos" className="px-4 py-1.5 text-xs font-medium font-geist text-zinc-400 hover:text-white transition-colors uppercase tracking-wider">
                Cases
              </a>
              <a href="#planos" className="px-4 py-1.5 text-xs font-medium font-geist text-zinc-400 hover:text-white transition-colors uppercase tracking-wider">
                Planos
              </a>
            </div>

            {/* CTA / Action */}
            <div className="flex items-center gap-4">
              <a 
                href="#iniciar" 
                className="hidden sm:inline-flex hover:shadow-[0_0_30px_rgba(59,130,246,0.3)] transition-all text-xs font-semibold font-geist text-white bg-primary hover:bg-primary-hover rounded-full px-5 py-2.5 active:scale-[0.98]"
              >
                Falar com Especialista
              </a>
              <button 
                onClick={() => alert('Menu móvel clicado')} 
                className="md:hidden flex items-center justify-center text-white p-2"
                aria-label="Toggle Menu"
              >
                <iconify-icon icon="solar:hamburger-menu-linear" className="text-2xl"></iconify-icon>
              </button>
            </div>
          </header>

          {/* Section 1 - HERO */}
          <section className="relative flex flex-col items-center justify-center pt-20 pb-16 text-center z-10 flex-grow animate-on-scroll">
            <div className="max-w-4xl mx-auto space-y-8">
              <h1 className="font-geist text-4xl sm:text-6xl md:text-7xl font-bold tracking-[-0.05em] text-white leading-tight uppercase">
                Escale com Estratégia.<br />Criado pela Limited.
              </h1>
              
              <p className="font-inter text-base md:text-lg text-text-muted max-w-2xl mx-auto leading-relaxed">
                Nós não criamos apenas sites; construímos ativos digitais de alta performance que convertem visitantes em clientes e geram receita previsível para a sua marca.
              </p>

              <div className="pt-4">
                <a 
                  href="#iniciar" 
                  className="group relative inline-flex items-center justify-center px-8 py-4 bg-primary text-white font-geist font-semibold rounded-lg shadow-[0_0_30px_rgba(59,130,246,0.3)] transition-all hover:bg-primary-hover active:scale-[0.98] overflow-hidden"
                >
                  <span className="relative block h-6 overflow-hidden">
                    <span className="block transition-transform duration-300 transform group-hover:-translate-y-8">Iniciar Projeto</span>
                    <span className="absolute top-0 left-0 block transition-transform duration-300 transform translate-y-8 group-hover:translate-y-0">Iniciar Projeto</span>
                  </span>
                  {/* Bottom glowing line */}
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-white to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></span>
                </a>
              </div>
            </div>
          </section>

          {/* Section 2 - TRUSTED BY */}
          <section className="py-12 border-t border-white/5 animate-on-scroll">
            <p className="text-center text-xs font-geist uppercase tracking-widest text-text-dim mb-8">
              Parceiros Globais & Clientes que Confiam
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-8 items-center justify-items-center">
              {[
                "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/d052699d-f578-4c01-9806-f5b6c8609489_320w.png",
                "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/3185425e-0207-434a-9554-cdb5bd455ea5_320w.png",
                "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/6c26c041-308e-4034-9227-5a6c57d94f4d_1600w.png",
                "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/8de253ef-3c06-4a22-8e14-1a6a9d8580d5_320w.png",
                "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/7d3f4a52-05b5-4539-987a-d4b1ff330ef1_1600w.png",
                "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/e561d59c-a675-431e-a035-187a88fbe4c2_1600w.png"
              ].map((logo, index) => (
                <div 
                  key={index}
                  style={{ 
                    backgroundImage: `url(${logo})`, 
                    backgroundSize: 'contain', 
                    backgroundPosition: 'center', 
                    backgroundRepeat: 'no-repeat' 
                  }} 
                  className={`w-[100px] h-[40px] opacity-60 hover:opacity-100 transition-opacity duration-300 ${index === 0 ? 'invert' : ''}`}
                ></div>
              ))}
            </div>
          </section>

          {/* Section 3 - THE MANIFESTO */}
          <section id="manifesto" className="py-section max-w-5xl mx-auto w-full animate-on-scroll">
            <div className="relative bg-neutral-900/50 border border-white/10 rounded-2xl p-8 md:p-16 overflow-hidden">
              <iconify-icon 
                icon="solar:quote-left-bold" 
                className="absolute top-6 left-6 text-white/5 text-[10rem] pointer-events-none"
              ></iconify-icon>
              
              <div class="relative z-10 flex flex-col gap-6">
                <span className="text-xs uppercase tracking-widest text-primary font-geist font-semibold">
                  O Manifesto
                </span>
                <h2 className="font-geist text-3xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-tight">
                  Design sem estratégia de negócios é apenas arte decorativa.
                </h2>
                <p className="font-inter text-base md:text-lg text-text-muted leading-relaxed max-w-3xl">
                  Rejeitamos a burocracia das agências tradicionais. Nós não vendemos reuniões intermináveis ou entregáveis estáticos. Nós criamos velocidade. Cada milissegundo de carregamento e cada pixel posicionado têm um único objetivo: converter tráfego qualificado em receita recorrente.
                </p>
              </div>
            </div>
          </section>

          {/* Section 4 - COMPARISON (US VS THEM) */}
          <section id="diferenciais" className="py-section max-w-5xl mx-auto w-full animate-on-scroll">
            <div className="text-center mb-16">
              <span className="text-xs uppercase tracking-widest text-primary font-geist font-semibold">
                Diferenciais
              </span>
              <h2 className="font-geist text-3xl md:text-5xl font-bold tracking-tight text-white mt-2">
                Limited vs Agências Tradicionais
              </h2>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Left Column: Traditional */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-8 opacity-60 grayscale hover:grayscale-0 hover:opacity-80 transition-all duration-500">
                <h3 className="font-geist text-2xl font-bold text-white/80 mb-8 flex items-center gap-3">
                  <iconify-icon icon="solar:close-circle-linear" className="text-red-500 text-3xl"></iconify-icon>
                  Agências Tradicionais
                </h3>
                <ul className="space-y-6 font-inter text-sm text-text-dim">
                  <li className="flex items-start gap-4">
                    <span className="text-red-500 font-bold">•</span>
                    <span>Lançamentos morosos em 2 a 3 meses de desenvolvimento lento.</span>
                  </li>
                  <li className="flex items-start gap-4">
                    <span className="text-red-500 font-bold">•</span>
                    <span>Orçamentos obscuros e mudanças frequentes no escopo contratado.</span>
                  </li>
                  <li className="flex items-start gap-4">
                    <span className="text-red-500 font-bold">•</span>
                    <span>Foco estético decorativo sem métricas de conversão.</span>
                  </li>
                  <li className="flex items-start gap-4">
                    <span className="text-red-500 font-bold">•</span>
                    <span>Gerentes de conta intermediários e comunicação burocrática.</span>
                  </li>
                </ul>
              </div>

              {/* Right Column: Limited */}
              <div className="relative bg-blue-950/10 border border-blue-500/30 rounded-2xl p-8 shadow-[0_0_40px_rgba(59,130,246,0.15)] overflow-hidden">
                <div className="absolute top-6 right-6 flex h-3.5 w-3.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-blue-500"></span>
                </div>
                
                <h3 className="font-geist text-2xl font-bold text-white mb-8 flex items-center gap-3">
                  <iconify-icon icon="solar:check-circle-linear" className="text-blue-500 text-3xl"></iconify-icon>
                  Limited Design
                </h3>
                <ul className="space-y-6 font-inter text-sm text-white/90">
                  <li className="flex items-start gap-4">
                    <iconify-icon icon="solar:arrow-right-linear" className="text-blue-500 mt-1 flex-shrink-0"></iconify-icon>
                    <span>Lançamentos acelerados (de 7 a 14 dias úteis).</span>
                  </li>
                  <li className="flex items-start gap-4">
                    <iconify-icon icon="solar:arrow-right-linear" className="text-blue-500 mt-1 flex-shrink-0"></iconify-icon>
                    <span>Preços fixos mensais sem pegadinhas ou cobranças ocultas.</span>
                  </li>
                  <li className="flex items-start gap-4">
                    <iconify-icon icon="solar:arrow-right-linear" className="text-blue-500 mt-1 flex-shrink-0"></iconify-icon>
                    <span>Foco absoluto em performance, SEO e taxas de conversão (ROI).</span>
                  </li>
                  <li className="flex items-start gap-4">
                    <iconify-icon icon="solar:arrow-right-linear" className="text-blue-500 mt-1 flex-shrink-0"></iconify-icon>
                    <span>Comunicação direta com especialistas no Slack e Trello.</span>
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* Section: CASE STUDIES */}
          <section id="casos" className="py-section max-w-5xl mx-auto w-full animate-on-scroll">
            <div className="text-center mb-16">
              <span className="text-xs uppercase tracking-widest text-primary font-geist font-semibold">
                Casos de Sucesso
              </span>
              <h2 className="font-geist text-3xl md:text-5xl font-bold tracking-tight text-white mt-2">
                Trabalho com Propósito
              </h2>
            </div>

            <div className="group relative bg-neutral-900/40 border border-white/10 rounded-2xl overflow-hidden hover:border-white/20 transition-all duration-500">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="p-8 md:p-12 space-y-6">
                  <span className="bg-blue-500/15 text-blue-300 text-xs px-3 py-1 rounded-full font-geist font-semibold uppercase tracking-wider">
                    Plataformas Digitais
                  </span>
                  <h3 className="font-geist text-2xl md:text-3xl font-bold text-white tracking-tight">
                    Volaris Global
                  </h3>
                  <p className="font-inter text-sm text-text-muted leading-relaxed">
                    Recriamos a infraestrutura visual e o design system do ecossistema Volaris, otimizando velocidade de carregamento e impulsionando as vendas orgânicas com layout ultra-focado no produto.
                  </p>
                  
                  <div className="flex items-center gap-8 pt-4">
                    <div>
                      <p className="font-geist text-3xl font-bold text-blue-500">+124%</p>
                      <p className="text-[10px] text-text-dim uppercase tracking-wider font-semibold">Conversão Móvel</p>
                    </div>
                    <div>
                      <p className="font-geist text-3xl font-bold text-blue-500">&lt; 0.8s</p>
                      <p className="text-[10px] text-text-dim uppercase tracking-wider font-semibold">Tempo de Resposta</p>
                    </div>
                  </div>
                </div>
                <div className="relative overflow-hidden h-[300px] md:h-full min-h-[300px]">
                  <img 
                    src="https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/5badae71-a5f7-4201-aee1-3b316e682fb0_1600w.jpg" 
                    alt="Volaris Card Case Study Screen" 
                    className="absolute inset-0 w-full h-full object-cover group-hover:scale-102 transition-transform duration-700" 
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Section 5 - PRICING GRID */}
          <section id="planos" className="py-section max-w-6xl mx-auto w-full animate-on-scroll">
            <div className="text-center mb-16">
              <span className="text-xs uppercase tracking-widest text-primary font-geist font-semibold">
                Nossos Planos
              </span>
              <h2 className="font-geist text-3xl md:text-5xl font-bold tracking-tight text-white mt-2">
                Preços Simples e Transparentes
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* Card 1: O Lançamento */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:bg-white/[0.07] transition-colors flex flex-col justify-between">
                <div>
                  <span className="text-xs text-text-dim uppercase tracking-wider font-semibold font-geist">MVP & Validação</span>
                  <h3 class="font-geist text-lg font-bold text-white mt-2">O Lançamento</h3>
                  <p class="font-geist text-3xl font-bold text-white mt-4">R$ 2.900</p>
                  <ul class="space-y-4 mt-8 text-xs text-text-muted">
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> One Page Landing</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> SEO Técnico Otimizado</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Integração Google & Meta</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Entrega em 5 dias úteis</li>
                  </ul>
                </div>
                <a href="#iniciar" className="mt-8 block text-center py-2.5 text-xs font-semibold font-geist text-white bg-white/10 border border-white/10 rounded-full hover:bg-white/20 transition-all">
                  Escolher Plano
                </a>
              </div>

              {/* Card 2: O Essencial da Marca */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:bg-white/[0.07] transition-colors flex flex-col justify-between">
                <div>
                  <span className="text-xs text-text-dim uppercase tracking-wider font-semibold font-geist">Startups Iniciais</span>
                  <h3 class="font-geist text-lg font-bold text-white mt-2">O Essencial da Marca</h3>
                  <p class="font-geist text-3xl font-bold text-white mt-4">R$ 4.900</p>
                  <ul class="space-y-4 mt-8 text-xs text-text-muted">
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Site Institucional (5p)</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Copywriting Profissional</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Design Premium exclusivo</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Entrega em 10 dias úteis</li>
                  </ul>
                </div>
                <a href="#iniciar" className="mt-8 block text-center py-2.5 text-xs font-semibold font-geist text-white bg-white/10 border border-white/10 rounded-full hover:bg-white/20 transition-all">
                  Escolher Plano
                </a>
              </div>

              {/* Card 3: O Motor de Crescimento (Featured) */}
              <div 
                className="relative bg-blue-900/10 border border-blue-500/30 ring-1 ring-blue-500/20 rounded-2xl p-6 hover:bg-white/[0.07] transition-colors flex flex-col justify-between overflow-hidden"
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_-20%,rgba(59,130,246,0.15),transparent_60%)] pointer-events-none"></div>
                <div className="relative z-10">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-blue-400 uppercase tracking-wider font-semibold font-geist">Recomendado</span>
                    <span className="bg-blue-500/20 text-blue-300 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase font-geist">Destaque</span>
                  </div>
                  <h3 class="font-geist text-lg font-bold text-white mt-2">O Motor de Crescimento</h3>
                  <p class="font-geist text-3xl font-bold text-white mt-4">R$ 8.900</p>
                  <ul class="space-y-4 mt-8 text-xs text-white/90">
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Multi-page Web (10p+)</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Landing Pages ilimitadas</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Painel CMS Administrativo</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Canal Direto via Slack/Trello</li>
                  </ul>
                </div>
                <a href="#iniciar" className="relative z-10 mt-8 block text-center py-3 text-xs font-semibold font-geist text-white bg-primary rounded-full hover:bg-primary-hover transition-all shadow-[0_0_20px_rgba(59,130,246,0.4)]">
                  Escolher Plano
                </a>
              </div>

              {/* Card 4: O Pacote E-Commerce */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:bg-white/[0.07] transition-colors flex flex-col justify-between">
                <div>
                  <span className="text-xs text-text-dim uppercase tracking-wider font-semibold font-geist">Lojas Virtuais</span>
                  <h3 class="font-geist text-lg font-bold text-white mt-2">O Pacote E-Commerce</h3>
                  <p class="font-geist text-3xl font-bold text-white mt-4">R$ 14.900</p>
                  <ul class="space-y-4 mt-8 text-xs text-text-muted">
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Plataforma Shopify / Custom</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Otimização de Funil Checkout</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> Sistema ERP / Pagamentos</li>
                    <li class="flex items-center gap-2"><iconify-icon icon="solar:check-circle-linear" className="text-blue-500"></iconify-icon> 30 Dias de Suporte Pós-envio</li>
                  </ul>
                </div>
                <a href="#iniciar" className="mt-8 block text-center py-2.5 text-xs font-semibold font-geist text-white bg-white/10 border border-white/10 rounded-full hover:bg-white/20 transition-all">
                  Escolher Plano
                </a>
              </div>
            </div>
          </section>

          {/* Section 6 - APPLICATION FORM */}
          <section id="iniciar" className="py-section relative overflow-hidden rounded-3xl border border-white/10 animate-on-scroll">
            
            {/* Form Background Image Layer */}
            <div 
              className="absolute inset-0 bg-cover bg-center z-0 pointer-events-none" 
              style={{ backgroundImage: 'url(https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/278bbef6-c861-4ed8-b799-a4713ff032b4_3840w.jpg)' }}
            ></div>
            {/* Absolute Overlay */}
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-10 pointer-events-none"></div>

            <div className="relative z-20 max-w-3xl mx-auto px-6 py-8">
              <div className="text-center mb-12">
                <span className="text-xs uppercase tracking-widest text-primary font-geist font-semibold">
                  Vamos Trabalhar Juntos
                </span>
                <h2 className="font-geist text-3xl md:text-5xl font-bold tracking-tight text-white mt-2">
                  Iniciar Projeto
                </h2>
                <p className="font-inter text-sm text-text-muted mt-3">
                  Preencha o formulário abaixo e retornaremos com uma proposta desenhada para o seu negócio.
                </p>
              </div>

              {formSubmitted ? (
                <div className="bg-blue-950/20 border border-blue-500/30 rounded-2xl p-8 text-center backdrop-blur-md">
                  <iconify-icon icon="solar:check-circle-linear" className="text-blue-500 text-5xl mb-4"></iconify-icon>
                  <h3 className="font-geist text-xl font-bold text-white">Solicitação Recebida!</h3>
                  <p className="font-inter text-sm text-text-muted mt-2">
                    Obrigado por entrar em contato. Um de nossos especialistas em estratégia digital responderá seu contato em breve.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-6 bg-white/[0.02] border border-white/10 rounded-2xl p-6 md:p-8 backdrop-blur-md">
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="flex flex-col gap-2">
                      <label className="text-xs text-text-muted font-geist uppercase font-semibold">Nome Completo</label>
                      <input 
                        type="text" 
                        name="name" 
                        value={formData.name} 
                        onChange={handleChange} 
                        required 
                        placeholder="Seu nome" 
                        className="bg-white/5 border border-white/10 rounded-md p-3 text-white text-sm focus:border-blue-500 focus:outline-none transition-colors" 
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-xs text-text-muted font-geist uppercase font-semibold">E-mail Profissional</label>
                      <input 
                        type="email" 
                        name="email" 
                        value={formData.email} 
                        onChange={handleChange} 
                        required 
                        placeholder="seu@email.com" 
                        className="bg-white/5 border border-white/10 rounded-md p-3 text-white text-sm focus:border-blue-500 focus:outline-none transition-colors" 
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="flex flex-col gap-2">
                      <label className="text-xs text-text-muted font-geist uppercase font-semibold">Orçamento Estimado</label>
                      <div className="relative">
                        <select 
                          name="budget" 
                          value={formData.budget} 
                          onChange={handleChange} 
                          required
                          className="w-full bg-black/60 border border-white/10 rounded-md p-3 text-white text-sm focus:border-blue-500 focus:outline-none appearance-none transition-colors"
                        >
                          <option value="" disabled>Selecione um intervalo</option>
                          <option value="ate-5k">Até R$ 5.000</option>
                          <option value="5k-15k">R$ 5.000 a R$ 15.000</option>
                          <option value="15k-30k">R$ 15.000 a R$ 30.000</option>
                          <option value="mais-30k">Mais de R$ 30.000</option>
                        </select>
                        <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-text-muted">
                          <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                            <path d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex flex-col gap-2">
                      <label className="text-xs text-text-muted font-geist uppercase font-semibold">Objetivo Principal</label>
                      <div className="relative">
                        <select 
                          name="goal" 
                          value={formData.goal} 
                          onChange={handleChange} 
                          required
                          className="w-full bg-black/60 border border-white/10 rounded-md p-3 text-white text-sm focus:border-blue-500 focus:outline-none appearance-none transition-colors"
                        >
                          <option value="" disabled>Selecione seu objetivo</option>
                          <option value="novo-site">Novo Site de Alta Performance</option>
                          <option value="redesign">Redesign Estratégico</option>
                          <option value="landing-page">Landing Page de Alta Conversão</option>
                          <option value="e-commerce">Loja E-Commerce Completa</option>
                        </select>
                        <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-text-muted">
                          <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                            <path d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-xs text-text-muted font-geist uppercase font-semibold">Detalhes do Projeto</label>
                    <textarea 
                      name="details" 
                      value={formData.details} 
                      onChange={handleChange} 
                      required
                      rows="4" 
                      placeholder="Conte-nos brevemente sobre sua empresa e os principais desafios..." 
                      className="bg-white/5 border border-white/10 rounded-md p-3 text-white text-sm focus:border-blue-500 focus:outline-none transition-colors resize-none"
                    ></textarea>
                  </div>

                  <button 
                    type="submit" 
                    className="w-full py-4 bg-primary text-white font-geist font-semibold rounded-lg hover:bg-primary-hover active:scale-[0.99] transition-all shadow-[0_0_30px_rgba(59,130,246,0.3)]"
                  >
                    Enviar Solicitação
                  </button>
                </form>
              )}
            </div>
          </section>

          {/* Footer */}
          <footer className="py-12 border-t border-white/5 mt-auto flex flex-col sm:flex-row items-center justify-between gap-6">
            <img 
              src="https://i.ibb.co/ZRc2kt2R/logotype.png" 
              alt="Limited Logotype" 
              className="h-4 object-contain opacity-60" 
            />
            <p className="text-xs font-geist text-text-dim">
              &copy; {new Date().getFullYear()} Limited. Todos os direitos reservados.
            </p>
          </footer>

        </div>
      </div>
    </div>
  );
}
