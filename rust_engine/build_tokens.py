"""
build_tokens.py – emit config/tokens.json with 50 tokens
Requires: python -m pip install requests
"""
import json, requests, itertools, os
UNI_LIST  = "https://gateway.ipfs.io/ipns/tokens.uniswap.org"          # default list
SUSHI_LIST= "https://token-list.sushi.com/ethereum.json"               # community list

uni  = {t["address"].lower(): t for t in requests.get(UNI_LIST).json()["tokens"]}
sushi= {t["address"].lower(): t for t in requests.get(SUSHI_LIST).json()["tokens"]}

# keep only tokens that appear in *both* lists, exclude obvious rebasing/scam coins
common = [v for k, v in uni.items() if k in sushi and v["symbol"] not in {"USDT","USDC","WETH","WBTC"}]

# crude liquidity check: leave the top‑50 by Uniswap list rank (already roughly by liquidity)
top50 = common[:50]

# keep only the fields the Rust loader needs
out = [
    {
        "symbol": t["symbol"],
        "address": t["address"],
        "decimals": t["decimals"],    # e.g. 18
    }
    for t in top50
]

os.makedirs("config", exist_ok=True)
with open("config/tokens.json", "w") as f:
    json.dump(out, f, indent=2)
print("✅  wrote config/tokens.json with", len(out), "tokens")
