#!/usr/bin/env python3
# build_tokens.py  –  create config/tokens.json (50 tokens on both DEXes)

import json, os, sys, itertools, requests

UNI_MIRRORS = [
    "https://unpkg.com/@uniswap/default-token-list@latest/build/uniswap-default.tokenlist.json",
    "https://raw.githubusercontent.com/Uniswap/default-token-list/main/build/uniswap-default.tokenlist.json",
]
SUSHI_MIRRORS = [
    "https://unpkg.com/@sushiswap/default-token-list@latest/build/sushiswap-default.tokenlist.json",
    "https://raw.githubusercontent.com/sushiswap/list/master/lists/token-lists/default-token-list/tokens/ethereum.json",
]

def fetch_first_ok(urls, name):
    """Try each URL until one returns 200 + valid JSON."""
    for u in urls:
        try:
            r = requests.get(u, timeout=15)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"[{name}] mirror failed {u[:60]}…  ({e.__class__.__name__})")
    sys.exit(f"❌  All mirrors for {name} failed")

print("📡  downloading token lists …")
uni  = fetch_first_ok(UNI_MIRRORS,   "Uniswap")["tokens"]
sushi= fetch_first_ok(SUSHI_MIRRORS, "Sushi")["tokens"]

# Build dict keyed by lowercase address for fast intersection
u_dict  = {t["address"].lower(): t for t in uni}
s_dict  = {t["address"].lower(): t for t in sushi}

# Intersection & simple liquidity heuristic: keep top‑50 by Uniswap rank
common = [v for k, v in u_dict.items() if k in s_dict]
top50  = common[:50]

out = [
    {
        "symbol":   t["symbol"],
        "address":  t["address"],
        "decimals": t["decimals"],
    }
    for t in top50
]

os.makedirs("config", exist_ok=True)
with open("config/tokens.json", "w") as f:
    json.dump(out, f, indent=2)

print(f"✅  wrote config/tokens.json with {len(out)} tokens")
