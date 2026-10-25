// Small enhancements only: the page is complete without JavaScript.
document.documentElement.classList.remove('no-js');

// Solid navigation once the page scrolls.
const nav = document.querySelector('.nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// Reveal sections as they enter the viewport; hero items stagger.
document.querySelectorAll('.hero .reveal').forEach((item, index) => item.style.setProperty('--i', index));
const reveal = (item) => item.classList.add('in');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  document.querySelectorAll('.reveal').forEach((item) => observer.observe(item));
} else document.querySelectorAll('.reveal').forEach(reveal);

// Copy buttons on code blocks.
document.querySelectorAll('[data-copy]').forEach((block) => {
  const button = block.querySelector('.copy');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(block.querySelector('code').textContent.trim());
      button.textContent = 'Copied';
      button.classList.add('done');
    } catch {
      button.textContent = 'Select & copy';
    }
    setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('done'); }, 1800);
  });
});
