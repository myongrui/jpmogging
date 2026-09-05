/* Replays a real audit run into the console's MachineWire API. */
(function () {
  const ctl = document.querySelector(".ctl");
  if (!ctl || !window.MachineWire) return;

  const wrap = document.createElement("div");
  wrap.className = "ctl";
  wrap.style.marginLeft = "8px";
  wrap.innerHTML =
    '<label for="run-pick">Run</label>' +
    '<select id="run-pick"><option value="">(none)</option></select>' +
    '<button class="btn" id="run-load">Load</button>';
  ctl.parentNode.insertBefore(wrap, ctl.nextSibling);

  const pick = wrap.querySelector("#run-pick");

  fetch("/api/runs")
    .then((r) => r.json())
    .then((d) => {
      for (const id of d.runs || []) {
        const o = document.createElement("option");
        o.value = o.textContent = id;
        pick.appendChild(o);
      }
    })
    .catch(() => {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  wrap.querySelector("#run-load").addEventListener("click", async () => {
    const id = pick.value;
    if (!id) return;
    window.MachineWire.reset();
    // The console seeds two setup rows for its scripted story; a real run has
    // only the transactions it actually settled.
    document.getElementById("ledger").innerHTML = "";
    const { events } = await fetch(`/api/runs/${id}/wire`).then((r) => r.json());
    for (const ev of events) {
      window.MachineWire.push(ev);
      await sleep(90);
    }
  });
})();
