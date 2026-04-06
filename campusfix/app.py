from flask import Flask, jsonify, render_template
import csv
import re
from pathlib import Path

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
CLASSROOM_CSV = BASE_DIR / 'classroom_data.csv'
BUILDING_CSV = BASE_DIR / 'building_coords.csv'
FACILITY_CSV_CANDIDATES = [
    BASE_DIR / 'facilities.csv',
    BASE_DIR / '편의시설.csv',
]


def parse_floor(room_code: str):
    if not room_code:
        return None
    text = str(room_code).strip()
    match = re.search(r'(?:[A-Za-z]?)(\d{1,4})', text)
    if not match:
        return None

    digits = match.group(1)
    try:
        if len(digits) >= 3:
            return int(digits[:-2])
        return int(digits[0])
    except ValueError:
        return None


def normalize_text(value):
    return ' '.join(str(value or '').replace('\u3000', ' ').split())


def open_csv_with_fallback(path):
    last_error = None
    for enc in ('utf-8-sig', 'cp949', 'euc-kr', 'utf-8'):
        try:
            return open(path, 'r', encoding=enc, newline='')
        except UnicodeDecodeError as exc:
            last_error = exc
    if last_error:
        raise last_error
    return open(path, 'r', encoding='utf-8-sig', newline='')


def get_facility_csv_path():
    for path in FACILITY_CSV_CANDIDATES:
        if path.exists():
            return path
    return None


def load_buildings():
    buildings = []
    with open_csv_with_fallback(BUILDING_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            building_name = normalize_text(row.get('building') or row.get('건물명'))
            lat_value = row.get('lat') or row.get('위도')
            lng_value = row.get('lng') or row.get('lag') or row.get('경도')
            if not building_name or lat_value in (None, '') or lng_value in (None, ''):
                continue
            buildings.append({
                'building': building_name,
                'lat': float(lat_value),
                'lng': float(lng_value),
            })
    return buildings


def load_classrooms():
    classrooms = []
    with open_csv_with_fallback(CLASSROOM_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            capacity_raw = normalize_text(row.get('수용인원'))
            classrooms.append({
                'id': int(float(row.get('No', 0) or 0)),
                'building': normalize_text(row.get('건물명')),
                'room_code': normalize_text(row.get('호실코드')),
                'room_name': normalize_text(row.get('호실명')),
                'room_type': normalize_text(row.get('호실구분')),
                'capacity': None if capacity_raw == '' else float(capacity_raw),
                'floor': parse_floor(row.get('호실코드', '')),
            })
    return classrooms


def load_facilities():
    building_lookup = {normalize_text(b['building']): b for b in load_buildings()}
    facilities = []

    facility_csv = get_facility_csv_path()
    if facility_csv is None:
        return facilities

    with open_csv_with_fallback(facility_csv) as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader, start=1):
            name = normalize_text(row.get('이름') or row.get('name') or row.get('시설명'))
            category = normalize_text(row.get('카테고리') or row.get('category') or row.get('시설유형'))
            building_name = normalize_text(row.get('건물명') or row.get('building'))
            floor_raw = normalize_text(row.get('층수') or row.get('floor') or row.get('층'))

            if not name or not building_name:
                continue

            building = building_lookup.get(building_name)

            facilities.append({
                'id': idx,
                'name': name,
                'category': category or '편의시설',
                'building': building_name,
                'floor': int(floor_raw) if floor_raw.isdigit() else floor_raw or None,
                'lat': building['lat'] if building else None,
                'lng': building['lng'] if building else None,
                'has_coordinates': bool(building),
            })
    return facilities


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/classrooms')
def api_classrooms():
    return jsonify(load_classrooms())


@app.route('/api/buildings')
def api_buildings():
    return jsonify(load_buildings())


@app.route('/api/facilities')
def api_facilities():
    return jsonify(load_facilities())


if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)
