"""Generate synthetic AAPL 1-minute test data for development."""
import os
import random
import datetime

random.seed(42)
os.makedirs("data/AAPL", exist_ok=True)

lines = ["timestamp,open,high,low,close,volume"]
dt = datetime.datetime(2023, 1, 3, 9, 30, 0)
price = 125.07

for _ in range(8000):
    o = round(price + random.uniform(-0.3, 0.3), 2)
    h = round(o + random.uniform(0, 0.5), 2)
    l = round(o - random.uniform(0, 0.5), 2)
    c = round(random.uniform(l, h), 2)
    v = random.randint(50000, 500000)
    ts = dt.strftime("%Y-%m-%d %H:%M:%S")
    lines.append(f"{ts},{o},{h},{l},{c},{v}")
    price = c + random.uniform(-0.2, 0.2)
    dt += datetime.timedelta(minutes=1)
    if dt.hour >= 16:
        dt = dt.replace(hour=9, minute=30, second=0) + datetime.timedelta(days=1)
        while dt.weekday() >= 5:
            dt += datetime.timedelta(days=1)

path = os.path.join("data", "AAPL", "AAPL_202301.csv")
with open(path, "w", newline="") as f:
    f.write("\n".join(lines) + "\n")

print(f"Created {path} with {len(lines) - 1} rows")
