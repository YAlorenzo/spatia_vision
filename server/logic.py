class SpatialAnalyzer:
    def __init__(self):
        # Белый список (оставляем только то, во что слепой человек может врезаться)
        self.whitelist = {"person", "chair", "door", "car", "couch", "bed", "tv", "laptop", "potted plant"}

    def analyze(self, raw_objects, frame_width):
        third = frame_width // 3
        processed_data = []
        
        for obj in raw_objects:
            if obj["class"] not in self.whitelist:
                continue
                
            # Определяем зоны для 3D-звука
            cx = obj["center_x"]
            if cx < third:
                zone, pan = "Ľ", -1.0
            elif cx < third * 2:
                zone, pan = "S", 0.0
            else:
                zone, pan = "P", 1.0
                
            processed_data.append({
                "class": obj["class"],
                "zone": zone,
                "distance": round(obj["distance"], 1),
                "pan": pan
            })
            
        # Сортируем объекты (самые близкие будут в начале списка)
        processed_data.sort(key=lambda x: x["distance"])
        return processed_data