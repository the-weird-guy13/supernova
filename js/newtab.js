// Fills in the Discord and GitHub links on the New Tab page from config/config.json.
fetch('config/config.json')
  .then(res => {
    if (!res.ok) {
      throw new Error('HTTP error ' + res.status);
    }
    return res.json();
  })
  .then(data => {
    const discord = document.querySelector('#discordLink a');
    if (discord) discord.href = data.discordLink;

    const github = document.getElementById('githubLink');
    if (github) {
      const link = document.createElement('a');
      link.href = data.githubLink;
      link.target = '_blank';
      link.textContent = 'GitHub Repository';
      github.appendChild(link);
    }
  })
  .catch(err => {
    console.error('Could not load config:', err);
  });
