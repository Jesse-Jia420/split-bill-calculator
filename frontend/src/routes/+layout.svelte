<script lang="ts">
  import '../app.css';
</script>

<div class="app">
  <header>
    <h1>split-bill-calculator</h1>
    <nav>
      <a href="/">Home</a>
      <a href="/health">Backend status</a>
    </nav>
  </header>
  <main>
    <slot />
  </main>
</div>

<style>
  .app {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 960px;
    margin: 0 auto;
    padding: 1rem 1.5rem;
    color: #222;
  }
  header {
    border-bottom: 1px solid #ddd;
    padding-bottom: 0.75rem;
    margin-bottom: 1.5rem;
    display: flex;
    align-items: baseline;
    gap: 1.5rem;
  }
  header h1 {
    font-size: 1.25rem;
    margin: 0;
  }
  nav {
    display: flex;
    gap: 1rem;
  }
  nav a {
    color: #555;
    text-decoration: none;
  }
  nav a:hover {
    text-decoration: underline;
  }
  main {
    line-height: 1.6;
  }
</style>
