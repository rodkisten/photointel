import io
import json
import unittest
from unittest.mock import patch

from infra.scripts.media_smoke_fixture import choose, eligible, valid_key


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class MediaSmokeFixtureTests(unittest.TestCase):
    def test_extensions_and_safe_paths(self):
        self.assertTrue(valid_key("originals/IMG_9654.png", "image"))
        self.assertTrue(valid_key("originals/clips/clip.mp4", "video"))
        self.assertFalse(valid_key("derived/x.png", "image"))
        self.assertFalse(valid_key("originals/../x.png", "image"))
        self.assertFalse(valid_key("originals/x.mp4", "image"))
        self.assertFalse(valid_key("originals/x\n.jpg", "image"))

    def test_size_and_content_type(self):
        self.assertTrue(eligible({"key": "originals/x.jpg", "size": 100}, "image"))
        self.assertFalse(eligible({"key": "originals/x.jpg", "size": 26 * 1024 * 1024}, "image"))
        self.assertFalse(eligible({"key": "originals/x.jpg", "size": 100, "http_metadata": {"contentType": "video/mp4"}}, "image"))

    def test_pagination_and_filtered_selection(self):
        pages = [
            {"success": True, "result": [{"key": "originals/x.jpg", "size": 200}], "result_info": {"is_truncated": True, "cursor": "next"}},
            {"success": True, "result": [{"key": "originals/y.jpg", "size": 200}, {"key": "originals/no.mp4", "size": 200}], "result_info": {"is_truncated": False}},
        ]
        urls = []

        def opener(request, timeout):
            urls.append(request.full_url)
            return FakeResponse(json.dumps(pages[len(urls) - 1]).encode())

        selected, count = choose("image", "a" * 32, "photointel", "test-token", opener=opener)
        self.assertIn(selected, {"originals/x.jpg", "originals/y.jpg"})
        self.assertEqual(count, 2)
        self.assertIn("cursor=next", urls[1])
        self.assertIn("prefix=originals", urls[0])

    def test_empty_bucket_fails_closed(self):
        def opener(request, timeout):
            return FakeResponse(b'{"success":true,"result":[],"result_info":{"is_truncated":false}}')

        with self.assertRaisesRegex(RuntimeError, "No eligible image"):
            choose("image", "a" * 32, "photointel", "test-token", opener=opener)


if __name__ == "__main__":
    unittest.main()
