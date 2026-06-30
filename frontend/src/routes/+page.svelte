<script lang="ts">
  import { FRONTEND_VERSION } from '$lib/version';
  import type { PageData } from './$types';

  export let data: PageData;
</script>

<section class="home">
  <div class="version-bar">
    <span>FE: <strong>{FRONTEND_VERSION}</strong></span>
    <span>BE: <strong>{data.backendVersion}</strong></span>
  </div>

  <div class="hero">
    <h1>Split Bill</h1>
    <p class="lead">多用户 + 多 session 的简洁记账工具</p>
    <div class="cta">
      <a class="btn primary" href="/auth/login">开始使用</a>
      <a class="btn" href="/sessions">我的 sessions</a>
    </div>
  </div>

  <ul class="features">
    <li>邮箱 + 验证码登录,无需密码</li>
    <li>每个 session 一个记账本,邀请链接永久有效</li>
    <li>AI 辅助:用一句话描述消费,自动填表单</li>
    <li>自动结算 + 转账路径,谁付谁一目了然</li>
  </ul>
</section>

<style>
  .home {
    padding-top: var(--space-5);
  }
  .version-bar {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-bottom: var(--space-3);
    display: flex;
    gap: var(--space-3);
    font-family: monospace;
  }
  .version-bar strong {
    color: var(--color-text);
  }
  .hero {
    text-align: center;
    margin-bottom: var(--space-6);
  }
  .hero h1 {
    font-size: 2rem;
    margin-bottom: var(--space-2);
  }
  .lead {
    color: var(--color-text-muted);
    margin-bottom: var(--space-5);
  }
  .cta {
    display: flex;
    gap: var(--space-3);
    justify-content: center;
    flex-wrap: wrap;
  }
  .features {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .features li {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text);
  }
  .features li:last-child {
    border-bottom: none;
  }
</style>